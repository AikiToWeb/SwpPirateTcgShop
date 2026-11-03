package com.swp.shop;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.net.http.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

class CardImageSourceTest {
    final ObjectMapper json=new ObjectMapper();
    HttpServer server;
    HttpClient client;
    CardImageService images;
    final Map<String,String> bodies=new ConcurrentHashMap<>();
    final List<URI> requests=new CopyOnWriteArrayList<>();
    int responseStatus=200;
    static String fixture(String name) throws Exception {try(var stream=CardImageSourceTest.class.getResourceAsStream("/card-images/"+name)){assertNotNull(stream);return new String(stream.readAllBytes(),StandardCharsets.UTF_8);}}
    static CardImageHttpClient.Resolver publicDns(){return host->new InetAddress[]{InetAddress.getByAddress(new byte[]{8,8,8,8})};}
    @BeforeEach void setup() throws Exception {
        server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);client=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
        bodies.put("/cardlist.do",fixture("onepiece.html"));bodies.put("/carddb/api/v1/advanced-search/",fixture("fab-search.json"));bodies.put("/carddb/api/v1/card_id/command-and-conquer-1/",fixture("fab-detail.json"));bodies.put("/ko-kr/card-gallery/",fixture("riftbound.html"));
        server.createContext("/",exchange->{byte[] bytes=bodies.getOrDefault(exchange.getRequestURI().getPath(),"not found").getBytes(StandardCharsets.UTF_8);exchange.getResponseHeaders().set("Content-Type","text/html; charset=utf-8");if(responseStatus==301)exchange.getResponseHeaders().set("Location","http://127.0.0.1/private");exchange.sendResponseHeaders(responseStatus,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();});server.start();
        var http=new CardImageHttpClient(uri->{requests.add(uri);URI local=URI.create("http://127.0.0.1:"+server.getAddress().getPort()+uri.getRawPath()+(uri.getRawQuery()==null?"":"?"+uri.getRawQuery()));var response=client.send(HttpRequest.newBuilder(local).timeout(Duration.ofSeconds(2)).GET().build(),HttpResponse.BodyHandlers.ofByteArray());return new CardImageHttpClient.Response(response.statusCode(),response.body());},publicDns(),0);
        images=new CardImageService(http,json);
    }
    @AfterEach void stop(){server.stop(0);client.close();}
    CardImageService.Result search(String game,String query,String language,int page){return images.search(new CardImageController.Search(game,query,language,page));}
    @Test void onePiecePreservesAllPrintsAndExcludesRuleTextOnlyMatches(){
        var result=search("원피스 카드게임"," 롤로노아 조로 ","한국어",0);assertEquals("OK",result.status());assertEquals(3,result.items().size());assertTrue(result.hasMore());
        assertEquals(List.of("OP01-001","OP01-001_p1","OP01-001_P2"),result.items().stream().map(CardImageService.Item::cardNumber).toList());assertEquals(3,result.items().stream().map(CardImageService.Item::id).distinct().count());
        assertTrue(result.items().stream().allMatch(item->item.language().equals("한국어")&&item.imageUrl().startsWith("https://onepiece-cardgame.kr/fileDownload?downname=")));
        assertTrue(requests.getFirst().getRawQuery().contains("series=all"));assertTrue(requests.getFirst().getRawQuery().contains("page=0"));
    }
    @Test void queryIsEncodedAndNoResultsDoesNotLoseSourcePagination(){
        var result=search("원피스 카드게임","없는 카드 & series=evil","ko",1);assertEquals("NO_RESULTS",result.status());assertTrue(result.hasMore());
        String query=requests.getFirst().getRawQuery();assertTrue(query.contains("%26"));assertEquals(1,query.split("series=",-1).length-1);assertEquals("onepiece-cardgame.kr",requests.getFirst().getHost());
    }
    @Test void cardNumberAndNormalizedNameSearchRemainDistinctFromOtherCards(){
        assertEquals(3,search("원피스 카드게임","op01-001","한국어",0).items().size());
        assertEquals(3,search("원피스 카드게임","롤로노아조로","한국어",0).items().size());
        assertEquals("NO_RESULTS",search("원피스 카드게임","몽키 D. 루피","한국어",0).status());
    }
    @Test void fabParsesActualPrintLanguageFoilAndPitchInsteadOfRelabelingRepresentative(){
        var result=search("플래시 앤 블러드","Command and Conquer","English",0);assertEquals("OK",result.status());assertEquals(2,result.items().size());assertFalse(result.hasMore());assertEquals("영어",result.items().getFirst().language());assertEquals("1",result.items().getFirst().pitch());
        assertTrue(result.items().get(1).variant().contains("rainbow-foil"));assertNotEquals(result.items().getFirst().id(),result.items().get(1).id());assertEquals("Arcane Rising",result.items().getFirst().setName());assertTrue(requests.getFirst().getRawQuery().contains("page_size=3"));assertEquals(2,requests.size());
    }
    @Test void fabNumberSearchUsesObservedGenericQueryAndDoesNotMergePitchVariants() throws Exception {
        var detail=(ObjectNode)json.readTree(fixture("fab-detail.json"));((ObjectNode)detail.path("results").get(0).path("card_prints").get(1).path("faces").get(0)).put("printed_pitch",2);bodies.put("/carddb/api/v1/card_id/command-and-conquer-1/",detail.toString());
        var result=search("플래시 앤 블러드","ARC159","en",0);assertEquals(2,result.items().size());assertEquals(List.of("1","2"),result.items().stream().map(CardImageService.Item::pitch).toList());assertTrue(requests.getFirst().getRawQuery().contains("q=ARC159"));
    }
    @Test void fabFanoutIsBoundedWithoutDroppingFourthOrFifthSearchResult() throws Exception {
        var response=(ObjectNode)json.readTree(fixture("fab-search.json"));response.put("count",7);response.put("next","https://api.cardvault.fabtcg.com/carddb/api/v1/advanced-search/?page=2");var list=response.withArray("results");for(int i=2;i<=3;i++){list.addObject().put("card_id","fixture-"+i);bodies.put("/carddb/api/v1/card_id/fixture-"+i+"/",fixture("fab-detail.json"));}bodies.put("/carddb/api/v1/advanced-search/",response.toString());
        var result=search("플래시 앤 블러드","Command and Conquer","영어",0);assertEquals("OK",result.status());assertEquals(4,requests.size());assertTrue(result.hasMore());assertTrue(requests.getFirst().getRawQuery().contains("page_size=3"));
    }
    @Test void riftboundUsesKoreanNameAndSubtitleAndCachesGalleryAcrossQueries(){
        var result=search("리프트바운드","가렌","한국어",0);assertEquals("OK",result.status());assertEquals(List.of("가렌, 강건","가렌, 지휘관"),result.items().stream().map(CardImageService.Item::name).toList());assertTrue(result.items().stream().allMatch(item->item.language().equals("한국어")));
        assertEquals(1,search("리프트바운드","OGS-013","ko-kr",0).items().size());assertEquals("NO_RESULTS",search("리프트바운드","English Placeholder","한국어",0).status());assertEquals(1,requests.size());
    }
    @Test void unsupportedGameAndLanguageNeverIssueNetworkRequests(){
        assertEquals("UNSUPPORTED_GAME",search("알 수 없는 게임","이름","한국어",0).status());assertEquals("UNSUPPORTED_LANGUAGE",search("플래시 앤 블러드","Command","한국어",0).status());assertEquals("UNSUPPORTED_LANGUAGE",search("원피스 카드게임","조로","영어",0).status());assertEquals("UNSUPPORTED_LANGUAGE",search("리프트바운드","Garen","영어",0).status());assertTrue(requests.isEmpty());
    }
    @Test void changedSourceMarkupAndRedirectsDoNotBecomeEmptySuccessfulSearches(){
        bodies.put("/cardlist.do","<html><h1>challenge or changed layout</h1></html>");assertEquals("SOURCE_UNAVAILABLE",search("원피스 카드게임","조로","한국어",0).status());
        responseStatus=301;assertEquals("SOURCE_UNAVAILABLE",search("리프트바운드","가렌","한국어",0).status());assertEquals(2,requests.size());assertTrue(requests.stream().noneMatch(uri->uri.getPath().equals("/private")));
    }
    @Test void unexpectedImageDestinationIsRejectedInsteadOfBeingReturned(){
        bodies.put("/cardlist.do",bodies.get("/cardlist.do").replace("/fileDownload?downname=202404240732471520","https://127.0.0.1/private.png"));var result=search("원피스 카드게임","조로","한국어",0);assertEquals("SOURCE_UNAVAILABLE",result.status());assertTrue(result.items().isEmpty());
    }
    @Test void imageAllowlistRejectsCredentialsPortsTraversalAdditionalQueriesAndLookalikeHosts(){
        for(String value:List.of("http://onepiece-cardgame.kr/fileDownload?downname=a","https://onepiece-cardgame.kr:8443/fileDownload?downname=a","https://onepiece-cardgame.kr.evil.test/fileDownload?downname=a","https://onepiece-cardgame.kr@127.0.0.1/fileDownload?downname=a","https://onepiece-cardgame.kr/fileDownload?downname=a&url=https://evil.test","https://onepiece-cardgame.kr/fileDownload?downname=%2e%2e","https://legendstory-production-s3-public.s3.amazonaws.com/media/cards/large/../private.webp","https://cmsassets.rgpub.io/sanity/images/other/dataset/a-1x1.png","https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/abc-1x1.png?url=private"))assertFalse(CardImageHttpClient.allowedImage(value),value);
        assertTrue(CardImageHttpClient.allowedImage("https://onepiece-cardgame.kr/fileDownload?downname=202404240732471520"));assertTrue(CardImageHttpClient.allowedImage("https://legendstory-production-s3-public.s3.amazonaws.com/media/cards/large/ARC159-RF.webp"));assertTrue(CardImageHttpClient.allowedImage("https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/abc-1488x2079.png?accountingTag=RB"));
    }
    @Test void privateDnsIsRejectedBeforeTransportAndFailuresNeverExposeInternalResponse(){
        var called=new AtomicInteger();var http=new CardImageHttpClient(uri->{called.incrementAndGet();return new CardImageHttpClient.Response(200,"private data".getBytes(StandardCharsets.UTF_8));},host->new InetAddress[]{InetAddress.getByName("127.0.0.1")},0);
        var service=new CardImageService(http,json);var result=service.search(new CardImageController.Search("원피스 카드게임","조로","한국어",0));assertEquals("SOURCE_UNAVAILABLE",result.status());assertEquals(0,called.get());assertFalse(result.message().contains("private data"));
    }
    @Test void timeoutAndOversizedBodiesProduceExplicitSourceUnavailable(){
        for(CardImageHttpClient.Transport transport:List.<CardImageHttpClient.Transport>of(uri->{throw new HttpTimeoutException("internal host must not leak");},uri->new CardImageHttpClient.Response(200,new byte[CardImageHttpClient.MAX_BYTES+1]))){
            var service=new CardImageService(new CardImageHttpClient(transport,publicDns(),0),json);var result=service.search(new CardImageController.Search("원피스 카드게임","조로","한국어",0));assertEquals("SOURCE_UNAVAILABLE",result.status());assertFalse(result.message().contains("internal host"));
        }
    }
    @Test void boundedBodySubscriberCancelsBeforeAccumulatingOversizedChunk(){
        var canceled=new AtomicBoolean();var subscriber=new CardImageHttpClient.LimitedSubscriber(5);subscriber.onSubscribe(new Flow.Subscription(){public void request(long count){}public void cancel(){canceled.set(true);}});subscriber.onNext(List.of(ByteBuffer.wrap(new byte[6])));assertTrue(canceled.get());assertTrue(subscriber.getBody().toCompletableFuture().isCompletedExceptionally());
    }
    @Test void publicAddressCheckRejectsPrivateIpv4Ipv6AndReservedRanges() throws Exception {
        for(String value:List.of("127.0.0.1","10.0.0.1","172.16.1.1","192.168.1.1","169.254.169.254","100.64.0.1","198.18.0.1","0.0.0.0","::1","fc00::1","fe80::1","2001:db8::1"))assertFalse(CardImageHttpClient.publicAddress(InetAddress.getByName(value)),value);
        assertTrue(CardImageHttpClient.publicAddress(InetAddress.getByName("8.8.8.8")));assertFalse(CardImageHttpClient.allowedRequest(URI.create("https://api.cardvault.fabtcg.com/carddb/api/v1/card_id/../private/")));
    }
    @Test void repeatedAndConcurrentIdenticalSearchesAreMergedAndResultCacheIsBounded() throws Exception {
        var calls=new AtomicInteger();var entered=new CountDownLatch(1);var release=new CountDownLatch(1);String fixture=fixture("onepiece.html");
        var http=new CardImageHttpClient(uri->{calls.incrementAndGet();entered.countDown();assertTrue(release.await(3,TimeUnit.SECONDS));return new CardImageHttpClient.Response(200,fixture.getBytes(StandardCharsets.UTF_8));},publicDns(),0);var service=new CardImageService(http,json);
        try(var threads=Executors.newFixedThreadPool(2)){
            var first=threads.submit(()->service.search(new CardImageController.Search("원피스 카드게임","조로","한국어",0)));assertTrue(entered.await(3,TimeUnit.SECONDS));var second=threads.submit(()->service.search(new CardImageController.Search("원피스 카드게임","조로","한국어",0)));release.countDown();assertSame(first.get(),second.get());assertEquals(1,calls.get());
        }
        for(int index=0;index<105;index++)service.search(new CardImageController.Search("원피스 카드게임","캐시"+index,"한국어",0));
        var field=CardImageService.class.getDeclaredField("cache");field.setAccessible(true);assertEquals(100,((Map<?,?>)field.get(service)).size());
    }
}
