package com.swp.shop;

import java.io.ByteArrayOutputStream;
import java.net.*;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.Flow;
import org.springframework.stereotype.Component;

/** Read-only, bounded access to the three official card catalogues. No user-supplied destination. */
@Component
public class CardImageHttpClient {
    static final int MAX_BYTES=8*1024*1024;
    static class SourceFailure extends RuntimeException {SourceFailure(){super("공식 카드 검색 출처에 연결할 수 없습니다.");}}
    record Response(int status,byte[] bytes){}
    @FunctionalInterface interface Transport {Response get(URI uri) throws Exception;}
    @FunctionalInterface interface Resolver {InetAddress[] resolve(String host) throws Exception;}
    private final Transport transport;
    private final Resolver resolver;
    private final long intervalNanos;
    private final Map<String,Long> lastRequest=new HashMap<>();
    private static final ExecutorService DNS=new ThreadPoolExecutor(2,2,0L,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(16),task->{var thread=new Thread(task,"card-image-dns");thread.setDaemon(true);return thread;},new ThreadPoolExecutor.AbortPolicy());
    public CardImageHttpClient(){this(productionTransport(),InetAddress::getAllByName,2000);}
    CardImageHttpClient(Transport transport,Resolver resolver,long intervalMillis){this.transport=transport;this.resolver=resolver;this.intervalNanos=TimeUnit.MILLISECONDS.toNanos(intervalMillis);}
    static boolean publicAddress(InetAddress address){
        if(address.isAnyLocalAddress()||address.isLoopbackAddress()||address.isLinkLocalAddress()||address.isSiteLocalAddress()||address.isMulticastAddress())return false;
        byte[] raw=address.getAddress();
        if(raw.length==16)return (raw[0]&0xfe)!=0xfc&&!((raw[0]&255)==0x20&&(raw[1]&255)==1&&(raw[2]&255)==0x0d&&(raw[3]&255)==0xb8);
        int a=raw[0]&255,b=raw[1]&255,c=raw[2]&255;
        return a!=0&&a!=127&&a<224&&!(a==100&&b>=64&&b<=127)&&!(a==169&&b==254)&&!(a==192&&b==0)&&!(a==192&&b==0&&c==2)&&!(a==198&&(b==18||b==19||b==51))&&!(a==203&&b==0&&c==113);
    }
    private static boolean base(URI uri){return uri!=null&&"https".equals(uri.getScheme())&&uri.getHost()!=null&&uri.getUserInfo()==null&&uri.getFragment()==null&&(uri.getPort()==-1||uri.getPort()==443)&&uri.toString().length()<=1800;}
    static boolean allowedRequest(URI uri){
        if(!base(uri))return false;String host=uri.getHost(),path=uri.getRawPath();
        if(host.equals("onepiece-cardgame.kr"))return path.equals("/cardlist.do");
        if(host.equals("api.cardvault.fabtcg.com"))return path.equals("/carddb/api/v1/advanced-search/")||path.matches("/carddb/api/v1/card_id/[a-z0-9-]{1,160}/");
        return host.equals("playriftbound.com")&&path.equals("/ko-kr/card-gallery/")&&uri.getRawQuery()==null;
    }
    static boolean allowedImage(String value){
        try{
            URI uri=URI.create(value);if(!base(uri)||value.length()>1000)return false;String host=uri.getHost(),path=uri.getRawPath(),query=uri.getRawQuery();
            if(host.equals("onepiece-cardgame.kr"))return path.equals("/fileDownload")&&query!=null&&query.matches("downname=[A-Za-z0-9_-]{1,180}");
            if(host.equals("legendstory-production-s3-public.s3.amazonaws.com"))return query==null&&path.matches("/media/cards/(small|normal|large)/[A-Za-z0-9_-]+\\.(webp|png|jpg|jpeg)");
            return host.equals("cmsassets.rgpub.io")&&path.matches("/sanity/images/dsfx7636/game_data_live/[a-f0-9]+-[0-9]+x[0-9]+\\.(png|webp|jpg|jpeg)")&&(query==null||query.equals("accountingTag=RB"));
        }catch(IllegalArgumentException ignored){return false;}
    }
    private synchronized void throttle(String host) throws InterruptedException {
        long wait=intervalNanos-(System.nanoTime()-lastRequest.getOrDefault(host,Long.MIN_VALUE/2));
        if(wait>0)TimeUnit.NANOSECONDS.sleep(wait);
        lastRequest.put(host,System.nanoTime());
    }
    public String get(URI uri){
        if(!allowedRequest(uri))throw new SourceFailure();
        try{
            var resolving=DNS.submit(()->resolver.resolve(uri.getHost()));InetAddress[] addresses;
            try{addresses=resolving.get(4,TimeUnit.SECONDS);}finally{resolving.cancel(true);}
            if(addresses.length==0||Arrays.stream(addresses).anyMatch(address->!publicAddress(address)))throw new SourceFailure();
            throttle(uri.getHost());var response=transport.get(uri);
            if(response.status()!=200||response.bytes()==null||response.bytes().length>MAX_BYTES)throw new SourceFailure();
            return new String(response.bytes(),StandardCharsets.UTF_8);
        }catch(InterruptedException interrupted){Thread.currentThread().interrupt();throw new SourceFailure();}
        catch(Exception ignored){throw new SourceFailure();}
    }
    private static Transport productionTransport(){
        var client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4)).followRedirects(HttpClient.Redirect.NEVER).build();
        return uri->{
            var subscriber=new LimitedSubscriber(MAX_BYTES);
            var request=HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(8)).header("User-Agent","SWP-CardImageLookup/1.0").header("Accept","text/html,application/json;q=0.9").GET().build();
            var pending=client.sendAsync(request,info->subscriber);
            try{var response=pending.get(8,TimeUnit.SECONDS);return new Response(response.statusCode(),response.body());}
            catch(Exception failure){pending.cancel(true);subscriber.cancel();throw new SourceFailure();}
        };
    }
    static final class LimitedSubscriber implements HttpResponse.BodySubscriber<byte[]> {
        private final int limit;
        private final ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        private final CompletableFuture<byte[]> result=new CompletableFuture<>();
        private Flow.Subscription subscription;
        LimitedSubscriber(int limit){this.limit=limit;}
        @Override public CompletionStage<byte[]> getBody(){return result;}
        @Override public void onSubscribe(Flow.Subscription subscription){this.subscription=subscription;subscription.request(1);}
        @Override public void onNext(List<ByteBuffer> buffers){
            if(result.isDone())return;
            for(var buffer:buffers){int length=buffer.remaining();if(length>limit-bytes.size()){cancel();return;}byte[] chunk=new byte[length];buffer.get(chunk);bytes.writeBytes(chunk);}
            subscription.request(1);
        }
        @Override public void onError(Throwable error){result.completeExceptionally(new SourceFailure());}
        @Override public void onComplete(){result.complete(bytes.toByteArray());}
        void cancel(){if(subscription!=null)subscription.cancel();result.completeExceptionally(new SourceFailure());}
    }
}
