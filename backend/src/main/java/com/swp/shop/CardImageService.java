package com.swp.shop;

import com.fasterxml.jackson.databind.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.Pattern;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Element;
import org.springframework.stereotype.Service;

@Service
public class CardImageService {
    static final String ONE="https://onepiece-cardgame.kr/cardlist.do",FAB="https://cardvault.fabtcg.com/",RIFT="https://playriftbound.com/ko-kr/card-gallery/";
    private static final String FAB_API="https://api.cardvault.fabtcg.com/carddb/api/v1/";
    private static final int FAB_PAGE_SIZE=3,MAX_PRINTS=60;
    public record Item(String id,String name,String cardNumber,String setName,String language,String variant,String pitch,String imageUrl,String sourceUrl){}
    public record Result(String status,String sourceName,String sourceUrl,List<Item> items,int page,boolean hasMore,String message,String checkedAt){public Result{items=List.copyOf(items);}}
    private record Key(String game,String query,String language,int page){}
    private record Cached(Result result,Instant expires){}
    private record Gallery(List<Item> items,Instant expires){}
    private final CardImageHttpClient http;
    private final ObjectMapper json;
    private final Map<Key,Cached> cache=new LinkedHashMap<>(128,0.75f,true);
    private final ConcurrentHashMap<Key,CompletableFuture<Result>> inFlight=new ConcurrentHashMap<>();
    private final Semaphore capacity=new Semaphore(4);
    private Gallery gallery;
    public CardImageService(CardImageHttpClient http,ObjectMapper json){this.http=http;this.json=json;}
    private static String encode(String value){return URLEncoder.encode(value,StandardCharsets.UTF_8);}
    static String normalized(String value){return Normalizer.normalize(Objects.toString(value,""),Normalizer.Form.NFKC).toLowerCase(Locale.ROOT).replaceAll("[\\s\\p{P}\\p{Z}]+","");}
    private static boolean korean(String value){return Pattern.compile("[가-힣]").matcher(value).find();}
    private static String koreanLanguage(String value){return Set.of("한국어","한글","ko","kor","korean","ko-kr").contains(value.toLowerCase(Locale.ROOT))?"한국어":null;}
    private static String englishLanguage(String value){return Set.of("영어","영문","en","eng","english","en-us").contains(value.toLowerCase(Locale.ROOT))?"영어":null;}
    private static String game(String value){return switch(value){case "원피스 카드게임"->"ONE";case "플래시 앤 블러드","플레시 앤 블러드","Flesh and Blood"->"FAB";case "리프트바운드"->"RIFT";default->"UNKNOWN";};}
    private static String source(String game){return switch(game){case "ONE"->"ONE PIECE 한국 공식 카드 검색";case "FAB"->"Flesh and Blood 공식 Card Vault";case "RIFT"->"Riftbound 한국 공식 카드 갤러리";default->"";};}
    private static String sourceUrl(String game){return switch(game){case "ONE"->ONE;case "FAB"->FAB;case "RIFT"->RIFT;default->"";};}
    private static Result result(Key key,String status,List<Item> items,boolean more,String message){return new Result(status,source(key.game),sourceUrl(key.game),items,key.page,more&&key.page<20,message,Instant.now().toString());}
    public Result search(CardImageController.Search request){
        if(request==null||request.game()==null||request.query()==null||request.language()==null||request.game().isBlank()||request.query().isBlank()||request.query().length()>120||request.query().indexOf('\0')>=0||request.language().isBlank()||request.language().length()>30||request.page()<0||request.page()>20)throw ShopService.error(422,"검색어·게임·언어·페이지를 확인해 주세요.");
        var key=new Key(game(request.game()),request.query(),request.language(),request.page());
        synchronized(cache){var found=cache.get(key);if(found!=null&&found.expires.isAfter(Instant.now()))return found.result;}
        var mine=new CompletableFuture<Result>();var existing=inFlight.putIfAbsent(key,mine);if(existing!=null)return existing.join();
        boolean acquired=capacity.tryAcquire();
        try{
            Result value;
            if(!acquired)value=result(key,"SOURCE_UNAVAILABLE",List.of(),false,"다른 공식 이미지 검색이 진행 중입니다. 잠시 후 다시 검색해 주세요.");
            else if(key.game.equals("UNKNOWN"))value=result(key,"UNSUPPORTED_GAME",List.of(),false,"이 게임의 공식 카드 이미지 검색은 지원하지 않습니다.");
            else if((key.game.equals("FAB")?englishLanguage(key.language):koreanLanguage(key.language))==null)value=result(key,"UNSUPPORTED_LANGUAGE",List.of(),false,key.game.equals("FAB")?"FaB 공식 검색은 현재 영어 인쇄본만 지원합니다. 한국어판으로 표시하지 않습니다.":"이 공식 출처에서는 한국어판만 검색합니다.");
            else try{value=switch(key.game){case "ONE"->onePiece(key);case "FAB"->fab(key);case "RIFT"->rift(key);default->throw new CardImageHttpClient.SourceFailure();};}
            catch(Exception ignored){value=result(key,"SOURCE_UNAVAILABLE",List.of(),false,"공식 출처의 응답을 확인할 수 없습니다. 연결 상태 또는 사이트 구조가 변경되었을 수 있습니다.");}
            synchronized(cache){cache.put(key,new Cached(value,Instant.now().plusSeconds(value.status.equals("SOURCE_UNAVAILABLE")?5:180)));while(cache.size()>100)cache.remove(cache.keySet().iterator().next());}
            mine.complete(value);return value;
        }finally{if(acquired)capacity.release();inFlight.remove(key,mine);}
    }
    private static String required(Element root,String selector){var field=root.selectFirst(selector);if(field==null||field.text().isBlank())throw new CardImageHttpClient.SourceFailure();return field.text().trim();}
    private static String image(String url){if(!CardImageHttpClient.allowedImage(url))throw new CardImageHttpClient.SourceFailure();return url;}
    private static String itemId(String source,String value){return source+":"+UUID.nameUUIDFromBytes(value.getBytes(StandardCharsets.UTF_8));}
    private Result onePiece(Key key){
        URI uri=URI.create(ONE+"?series=all&freewords="+encode(key.query)+"&page="+key.page+"&size=20");
        var document=Jsoup.parse(http.get(uri),ONE);var list=document.selectFirst(".card_sch_list");if(list==null)throw new CardImageHttpClient.SourceFailure();
        var items=new ArrayList<Item>();String query=normalized(key.query);var seen=new HashSet<String>();
        for(var row:list.select("button.item")){
            String name=required(row,".cardName"),number=required(row,".cardNumber");
            if(!normalized(name).contains(query)&&!normalized(number).contains(query))continue;
            var img=row.selectFirst("img.image[src]");if(img==null)throw new CardImageHttpClient.SourceFailure();String image=image(URI.create(ONE).resolve(img.attr("src")).toString());
            String id=itemId("ONE_PIECE",number+"|"+image);if(!seen.add(id))continue;
            int suffix=number.indexOf('_');String variant=suffix<0?"기본 코드":number.substring(suffix+1);
            items.add(new Item(id,name,number,required(row,".cardGet"),"한국어",variant,"",image,uri.toString()));
        }
        boolean more=document.selectFirst(".pagination a.pagi_next")!=null;
        return result(key,items.isEmpty()?"NO_RESULTS":"OK",items,more,"공식 한국어판의 이름·카드번호가 일치하는 후보입니다. 세트와 인쇄본을 확인해 선택하세요.");
    }
    private static boolean codeQuery(String query){return query.matches("(?i)(?:[a-z]{2}_)?(?:u-)?[a-z]{2,6}[0-9]{3}(?:-[a-z0-9]+)?");}
    private Result fab(Key key) throws Exception {
        boolean code=codeQuery(key.query);String parameter=code?"q":"name";
        var response=json.readTree(http.get(URI.create(FAB_API+"advanced-search/?"+parameter+"="+encode(key.query)+"&language=en&page_size="+FAB_PAGE_SIZE+"&page="+(key.page+1)+"&orderby=relevance")));
        if(response==null||!response.path("results").isArray()||!response.path("count").canConvertToLong()||response.path("count").asLong()<0||response.path("results").size()>FAB_PAGE_SIZE)throw new CardImageHttpClient.SourceFailure();
        var items=new ArrayList<Item>();var seen=new HashSet<String>();boolean limited=false;String query=normalized(key.query);
        for(var card:response.path("results")){
            String slug=card.path("card_id").asText();if(!slug.matches("[a-z0-9-]{1,160}"))throw new CardImageHttpClient.SourceFailure();
            var detail=json.readTree(http.get(URI.create(FAB_API+"card_id/"+slug+"/")));if(detail==null||!detail.path("results").isArray())throw new CardImageHttpClient.SourceFailure();
            for(var group:detail.path("results")){
                if(!group.path("card_prints").isArray())throw new CardImageHttpClient.SourceFailure();
                for(var print:group.path("card_prints")){
                    if(!print.path("is_published").asBoolean(false)||!print.path("print_language").asText().equals("en"))continue;
                    String printId=print.path("print_id").asText();if(!printId.matches("[A-Za-z0-9_-]{1,80}"))throw new CardImageHttpClient.SourceFailure();
                    for(var face:print.path("faces")){
                        if(face.path("layout_position").asInt()!=10||!face.path("face_language").asText().equals("en"))continue;
                        String name=face.path("printed_name").asText(),number=face.path("printed_code").asText(printId);if(name.isBlank())throw new CardImageHttpClient.SourceFailure();
                        if(code?!normalized(printId).contains(query)&&!normalized(number).contains(query):!normalized(name).contains(query))continue;
                        String image=image(face.path("image").path("large").asText()),id=itemId("FAB",printId+"|"+image);if(!seen.add(id))continue;
                        String set=print.path("print_set").path("set_name").asText(print.path("product").path("product_name").asText());if(set.isBlank())throw new CardImageHttpClient.SourceFailure();
                        var variant=new ArrayList<String>();variant.add(printId);for(String field:List.of("finish_type","art_type","border_type"))if(!face.path(field).asText().isBlank())variant.add(face.path(field).asText());
                        String pitch=face.path("printed_pitch").isIntegralNumber()&&face.path("printed_pitch").asInt()>=1&&face.path("printed_pitch").asInt()<=3?face.path("printed_pitch").asText():"";
                        if(items.size()>=MAX_PRINTS){limited=true;continue;}
                        items.add(new Item(id,name,number,set,"영어",String.join(" · ",variant),pitch,image,FAB+"card/"+slug+"/"+printId));
                    }
                }
            }
        }
        boolean more=!response.path("next").isNull()&&!response.path("next").isMissingNode()||response.path("count").asLong()>(long)(key.page+1)*FAB_PAGE_SIZE;
        String message="공식 영어 인쇄본입니다. 원본 카드 최대 3종의 인쇄본을 조회하며 세트·포일·피치를 확인해 선택하세요."+(limited?" 인쇄본이 많아 일부 후보만 표시합니다. 카드번호로 좁혀 검색해 주세요.":"");
        return result(key,items.isEmpty()?"NO_RESULTS":"OK",items,more,message);
    }
    private synchronized Gallery gallery() throws Exception {
        if(gallery!=null&&gallery.expires.isAfter(Instant.now()))return gallery;
        var document=Jsoup.parse(http.get(URI.create(RIFT)));var script=document.getElementById("__NEXT_DATA__");if(script==null)throw new CardImageHttpClient.SourceFailure();
        var next=json.readTree(script.data());if(next==null)throw new CardImageHttpClient.SourceFailure();JsonNode cards=null;
        for(var blade:next.path("props").path("pageProps").path("page").path("blades"))if(blade.path("type").asText().equals("riftboundCardGallery")){cards=blade.path("cards").path("items");break;}
        if(cards==null||!cards.isArray()||cards.isEmpty()||cards.size()>10000)throw new CardImageHttpClient.SourceFailure();
        var items=new ArrayList<Item>();var seen=new HashSet<String>();
        for(var card:cards){
            String name=card.path("name").asText(),alt=card.path("cardImage").path("accessibilityText").asText();
            if(!korean(name)||!korean(alt))continue; // Korean locale also contains unreleased English card placeholders.
            String number=card.path("publicCode").asText(),set=card.path("set").path("value").path("label").asText(),id=card.path("id").asText();
            if(number.isBlank()||set.isBlank()||id.isBlank())throw new CardImageHttpClient.SourceFailure();String image=image(card.path("cardImage").path("url").asText());
            var match=Pattern.compile("^[^:]{1,80}:\\s*([^。\\n.]{1,150})").matcher(alt);String title=match.find()?match.group(1).trim():name;
            if(!normalized(title).contains(normalized(name))||!korean(title))title=name;
            if(!seen.add(id))continue;
            items.add(new Item("RIFTBOUND:"+id,title,number,set,"한국어",title.equals(name)?number:title,"",image,RIFT));
        }
        gallery=new Gallery(List.copyOf(items),Instant.now().plusSeconds(900));return gallery;
    }
    private Result rift(Key key) throws Exception {
        var all=gallery().items;String query=normalized(key.query);var found=all.stream().filter(item->normalized(item.name).contains(query)||normalized(item.cardNumber).contains(query)).toList();
        int from=Math.min(found.size(),key.page*20),to=Math.min(found.size(),from+20);
        return result(key,from==to?"NO_RESULTS":"OK",found.subList(from,to),to<found.size(),"공식 한국어 갤러리가 제공한 항목 안에서 검색합니다. 영문 혼재 항목은 제외하며 카드번호·세트·이미지를 확인해 선택하세요.");
    }
}
