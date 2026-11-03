package com.swp.shop;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import java.net.URI;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import static com.swp.shop.PricingModels.*;

class PricingTest {
    static final String RD="https://tcgrollingdice.com/mtga/index.php?mode=card&set=M13&code=224",CN="https://cardnyang.com/mtg/index.php?mode=card&set=M13&code=224",DECK="https://cardnyang.com/fabtcg/index.php?mode=sealed&cate=XXCNYANGFABTCG";
    static final Instant OBSERVED=Instant.now().minusSeconds(60);
    String fixture(String name) throws Exception {try(var stream=getClass().getResourceAsStream("/pricing/"+name)){return new String(Objects.requireNonNull(stream).readAllBytes(),StandardCharsets.UTF_8);}}
    Request request(String rolling,String card,boolean absentR,boolean absentC){return new Request("진화하는 야생지","Evolving Wilds","Magic 2013","매직 더 개더링","한국어","NM","SINGLE",1,rolling,card,absentR,absentC,null,null,null,null,false);}
    @Test void capturedSingleOptionsUseExactLanguageAndCondition() throws Exception {
        var parser=new PricingParser();var r=request(RD,CN,false,false);
        assertEquals(500L,parser.parse("ROLLING_DICE",RD,fixture("rolling-m13-224.html"),r).price());
        Quote cn=parser.parse("CARDNYANG",CN,fixture("cardnyang-m13-224.html"),r);assertEquals(500L,cn.price(),cn.toString());
        Request wrong=new Request(r.name(),r.en(),"Other Set",r.game(),r.language(),r.condition(),r.productType(),1,RD,CN,false,false,null,null,null,null,false);
        assertEquals("NEEDS_REVIEW",parser.parse("ROLLING_DICE",RD,fixture("rolling-m13-224.html"),wrong).status());
        String zero=fixture("rolling-m13-224.html").replace("500원","0원");assertNull(parser.parse("ROLLING_DICE",RD,zero,r).price());
        String ambiguous=fixture("rolling-m13-224.html").replace("500원","500원 100원");assertEquals("NEEDS_REVIEW",parser.parse("ROLLING_DICE",RD,ambiguous,r).status());
    }
    @Test void capturedFabDeckUsesOnlyMatchingContainer() throws Exception {
        Request r=new Request("Armory Deck: Zyggy","","Armory Deck","플래시 앤 블러드","한국어","NM","DECK",1,null,DECK,false,false,null,null,null,null,false);
        Quote q=new PricingParser().parse("CARDNYANG",DECK,fixture("cardnyang-fab-decks.html"),r);
        assertEquals("READY",q.status(),q.toString());assertEquals(70000L,q.price()); // Other product cards contain much lower prices.
        Request box=new Request(r.name(),"",r.set(),r.game(),r.language(),"NM","BOX",1,null,DECK,false,false,null,null,null,null,false);
        assertEquals("NEEDS_REVIEW",new PricingParser().parse("CARDNYANG",DECK,fixture("cardnyang-fab-decks.html"),box).status());
        Request english=new Request(r.name(),"",r.set(),r.game(),"영어","NM","DECK",1,null,DECK,false,false,null,null,null,null,false);
        assertNull(new PricingParser().parse("CARDNYANG",DECK,fixture("cardnyang-fab-decks.html"),english).price());
    }
    @Test void malformedPriceTokensNeverUseANumericSuffix() throws Exception {
        var parser=new PricingParser();var r=request(RD,CN,false,false);
        for(String invalid:List.of("-500원","- 500원","−500원","+500원","500.5원","1.500원","1,50원","1 500원","500,원")){
            for(String source:List.of("ROLLING_DICE","CARDNYANG")){
                String url=source.equals("ROLLING_DICE")?RD:CN;
                String file=source.equals("ROLLING_DICE")?"rolling-m13-224.html":"cardnyang-m13-224.html";
                Quote q=parser.parse(source,url,fixture(file).replace("500원",invalid),r);
                assertEquals("NEEDS_REVIEW",q.status(),source+" "+invalid+" "+q);assertNull(q.price());
            }
        }
        for(String valid:List.of("1,500원","1500원","1,500 원"))assertEquals(1500L,parser.parse("ROLLING_DICE",RD,fixture("rolling-m13-224.html").replace("500원",valid),r).price(),valid);
    }
    @Test void capturedFabPacksBoxesAndMissingLanguageAreNotInvented() throws Exception {
        String ros="https://cardnyang.com/fabtcg/index.php?mode=sealed&cate=fabtcgROS";
        for(String type:List.of("PACK","BOX")){
            String title=type.equals("PACK")?"Rosetta Booster":"Rosetta Booster Box";
            var r=new Request(title,"","Rosetta","플래시 앤 블러드","영어","NM",type,1,null,ros,false,false,null,null,null,null,false);
            assertEquals("UNAVAILABLE",new PricingParser().parse("CARDNYANG",ros,fixture("cardnyang-fab-ros.html"),r).status());
        }
        String url="https://tcgrollingdice.com/fabtcg/index.php?mode=card&set=fabtcgIAR&code=AA2";
        var r=new Request("[Usurp the Shadow Throne] Play Booster Pack","","Usurp the Shadow Throne","플래시 앤 블러드","영어","NM","PACK",1,url,null,false,false,null,null,null,null,false);
        assertEquals("NEEDS_REVIEW",new PricingParser().parse("ROLLING_DICE",url,fixture("rolling-fab-iar-aa2.html"),r).status());
    }
    PricingService service(PricingPageClient pages){var jdbc=mock(JdbcTemplate.class);return new PricingService(pages,new PricingParser(),new ShopService(jdbc,mock(TransactionTemplate.class),"http://127.0.0.1:5175"),new ObjectMapper().registerModule(new JavaTimeModule()));}
    @Test void lowerMatchedSourceSelectedAndCollectionTimestampPreserved() throws Exception {
        var pages=mock(PricingPageClient.class);
        when(pages.fetch("ROLLING_DICE",RD)).thenReturn(new Page(fixture("rolling-m13-224.html"),OBSERVED));
        when(pages.fetch("CARDNYANG",CN)).thenReturn(new Page(fixture("cardnyang-m13-224.html").replace("500원","400원"),OBSERVED.plusSeconds(5)));
        var result=service(pages).quote("admin",request(RD,CN,false,false));assertEquals("READY",result.status());assertEquals(400L,result.recommendedPrice());assertEquals("CARDNYANG",result.selectedSource());assertEquals(OBSERVED,result.checkedAt());
    }
    @Test void communicationFailureAndMissingMappingNeverTriggerNaver() throws Exception {
        var pages=mock(PricingPageClient.class);when(pages.fetch(anyString(),anyString())).thenThrow(new java.io.IOException());
        var s=service(pages);assertEquals("UNAVAILABLE",s.quote("admin",request(RD,CN,false,false)).status());
        Result missing=s.quote("admin",request(null,CN,false,true));assertEquals("NEEDS_MAPPING",missing.status());assertEquals(2,missing.quotes().size());assertNull(missing.recommendedPrice());
    }
    @Test void manualNaverOnlyAfterBothAbsentAndFreshExplicitConfirmation(){
        var pages=mock(PricingPageClient.class);var s=service(pages);var base=request(null,null,true,true);
        assertEquals("UNAVAILABLE",s.quote("admin",base).status());
        Instant checked=Instant.now().minusSeconds(300);
        var r=new Request(base.name(),base.en(),base.set(),base.game(),base.language(),"NM","SINGLE",1,null,null,true,true,null,"https://smartstore.naver.com/merchant/products/123456",1000L,checked,true);
        Result result=s.quote("admin",r);assertEquals(1000L,result.recommendedPrice());assertEquals("NAVER_SMARTSTORE",result.selectedSource());assertEquals(checked,result.checkedAt());assertTrue(result.warnings().stream().anyMatch(w->w.contains("자동 조회가 아닙니다")));verifyNoInteractions(pages);
        var future=new Request(r.name(),r.en(),r.set(),r.game(),r.language(),"NM","SINGLE",1,null,null,true,true,null,r.naverUrl(),1000L,Instant.now().plusSeconds(600),true);
        assertEquals("NEEDS_REVIEW",s.quote("admin",future).status());
        var stale=new Request(r.name(),r.en(),r.set(),r.game(),r.language(),"NM","SINGLE",1,null,null,true,true,null,r.naverUrl(),1000L,Instant.now().minusSeconds(90000),true);
        assertNull(s.quote("admin",stale).recommendedPrice());
    }
    @Test void urlValidationRejectsSsrfAndMutationRoutes() throws Exception {
        var pages=new PricingPageClient();
        for(String url:List.of("http://tcgrollingdice.com/mtga/index.php?mode=card&set=M13&code=224","https://tcgrollingdice.com.evil.example/mtga/index.php?mode=card&set=M13&code=224","https://127.0.0.1/mtga/index.php?mode=card&set=M13&code=224","https://user@tcgrollingdice.com/mtga/index.php?mode=card&set=M13&code=224","https://tcgrollingdice.com/basket.php?mode=buy","https://tcgrollingdice.com/mtga/index.php?mode=card&set=M13&code=224&url=http://localhost"))assertThrows(IllegalArgumentException.class,()->pages.validated("ROLLING_DICE",url));
        assertEquals(URI.create(DECK),pages.validated("CARDNYANG",DECK));
        assertFalse(PricingPageClient.publicAddress(InetAddress.getByName("127.0.0.1")));assertFalse(PricingPageClient.publicAddress(InetAddress.getByName("10.0.0.1")));assertFalse(PricingPageClient.publicAddress(InetAddress.getByName("::1")));
    }
    @Test void bodyReadHasDeadlineAndSizeBound() throws Exception {
        var blocked=new java.io.InputStream(){boolean closed;public synchronized int read() throws java.io.IOException {while(!closed)try{wait();}catch(InterruptedException e){throw new java.io.IOException(e);}return -1;}public synchronized void close(){closed=true;notifyAll();}};
        assertTimeoutPreemptively(java.time.Duration.ofSeconds(2),()->assertThrows(java.net.http.HttpTimeoutException.class,()->PricingPageClient.readBounded(blocked,java.time.Duration.ofMillis(50))));
        byte[] oversized=new byte[800000];assertEquals(768*1024+1,PricingPageClient.readBounded(new java.io.ByteArrayInputStream(oversized),java.time.Duration.ofSeconds(1)).length);
    }
    @Test void repeatedQuotesAreLimitedEvenWithNoNetwork() {
        var s=service(mock(PricingPageClient.class));for(int i=0;i<12;i++)s.quote("limited-admin",request(null,null,true,true));
        var error=assertThrows(org.springframework.web.server.ResponseStatusException.class,()->s.quote("limited-admin",request(null,null,true,true)));assertEquals(429,error.getStatusCode().value());
    }
}
