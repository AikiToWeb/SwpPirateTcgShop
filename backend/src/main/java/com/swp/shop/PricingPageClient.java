package com.swp.shop;

import java.io.InputStream;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.stereotype.Component;

@Component
public class PricingPageClient {
    private static final int MAX_BYTES=768*1024,MAX_CACHE=100;
    private final HttpClient client=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(4)).build();
    private final Map<String,PricingModels.Page> cache=new ConcurrentHashMap<>();
    private final Map<String,Long> hosts=new HashMap<>();
    public URI validated(String source,String value){
        try{
            URI uri=URI.create(value);
            String host=source.equals("ROLLING_DICE")?"tcgrollingdice.com":"cardnyang.com";
            if(!uri.getScheme().equals("https")||!host.equals(uri.getHost())||uri.getUserInfo()!=null||uri.getFragment()!=null||(uri.getPort()!=-1&&uri.getPort()!=443))throw new IllegalArgumentException();
            Set<String> paths=source.equals("ROLLING_DICE")?Set.of("/mtga/index.php","/fabtcg/index.php","/rbtcg/index.php"):Set.of("/mtg/index.php","/fabtcg/index.php");
            if(!paths.contains(uri.getPath()))throw new IllegalArgumentException();
            var q=new HashMap<String,String>();
            if(uri.getRawQuery()==null)throw new IllegalArgumentException();
            for(String pair:uri.getRawQuery().split("&")){String[] a=pair.split("=",2);if(a.length!=2||q.put(a[0],URLDecoder.decode(a[1],StandardCharsets.UTF_8))!=null)throw new IllegalArgumentException();}
            boolean detail=q.keySet().equals(Set.of("mode","set","code"))&&"card".equals(q.get("mode"))&&q.get("set").matches("[A-Za-z0-9_-]{1,30}")&&q.get("code").matches("[A-Za-z0-9_-]{1,30}");
            boolean sealed=source.equals("CARDNYANG")&&q.keySet().equals(Set.of("mode","cate"))&&"sealed".equals(q.get("mode"))&&q.get("cate").matches("[A-Za-z0-9_-]{1,50}");
            if(!detail&&!sealed)throw new IllegalArgumentException();
            return uri;
        }catch(Exception ex){throw new IllegalArgumentException("지원하는 HTTPS 상품 상세 URL을 지정하세요.");}
    }
    public PricingModels.Page fetch(String source,String url) throws Exception {
        URI uri=validated(source,url);Instant now=Instant.now();var old=cache.get(url);
        if(old!=null&&old.collectedAt().plusSeconds(300).isAfter(now))return old;
        synchronized(hosts){long millis=System.currentTimeMillis();long last=hosts.getOrDefault(uri.getHost(),0L);if(millis-last<2000)throw new IllegalStateException("SOURCE_RATE_LIMIT");hosts.put(uri.getHost(),millis);}
        // Only two fixed public hosts are allowed. Validate DNS before each request; no user-selected redirects/proxies.
        for(InetAddress address:InetAddress.getAllByName(uri.getHost()))if(!publicAddress(address))throw new IllegalArgumentException("비공개 네트워크 주소는 조회할 수 없습니다.");
        var response=client.send(HttpRequest.newBuilder(uri).GET().timeout(Duration.ofSeconds(7)).header("User-Agent","SWPShop-PriceReference/1.0").header("Accept","text/html").build(),HttpResponse.BodyHandlers.ofInputStream());
        try(InputStream stream=response.body()){
            if(response.statusCode()!=200)throw new IllegalStateException("SOURCE_HTTP_"+response.statusCode());
            if(!response.headers().firstValue("Content-Type").orElse("").toLowerCase(Locale.ROOT).contains("text/html"))throw new IllegalStateException("UNEXPECTED_CONTENT_TYPE");
            byte[] bytes=readBounded(stream,Duration.ofSeconds(7));if(bytes.length>MAX_BYTES)throw new IllegalStateException("SOURCE_TOO_LARGE");
            var page=new PricingModels.Page(new String(bytes,StandardCharsets.UTF_8),Instant.now());
            if(cache.size()>=MAX_CACHE)cache.clear();cache.put(url,page);return page;
        }
    }
    static byte[] readBounded(InputStream stream,Duration timeout) throws Exception {
        FutureTask<byte[]> read=new FutureTask<>(()->stream.readNBytes(MAX_BYTES+1));
        Thread worker=Thread.ofVirtual().name("pricing-body-read").start(read);
        try{return read.get(timeout.toMillis(),TimeUnit.MILLISECONDS);}
        catch(TimeoutException e){stream.close();read.cancel(true);throw new java.net.http.HttpTimeoutException("SOURCE_BODY_TIMEOUT");}
        finally{if(!read.isDone()){read.cancel(true);worker.interrupt();}}
    }
    static boolean publicAddress(InetAddress a){byte[] b=a.getAddress();if(a.isAnyLocalAddress()||a.isLoopbackAddress()||a.isLinkLocalAddress()||a.isSiteLocalAddress()||a.isMulticastAddress())return false;if(b.length==16&&(b[0]&0xfe)==0xfc)return false;return !(b.length==4&&((b[0]&255)==0||(b[0]&255)==100&&((b[1]&255)>=64&&(b[1]&255)<=127)||(b[0]&255)>=224));}
}
