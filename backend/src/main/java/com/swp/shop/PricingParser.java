package com.swp.shop;

import java.net.URI;
import java.text.Normalizer;
import java.util.*;
import java.util.regex.*;
import org.jsoup.Jsoup;
import org.jsoup.nodes.*;
import org.springframework.stereotype.Component;
import static com.swp.shop.PricingModels.*;

@Component
public class PricingParser {
    private static final Pattern MONEY=Pattern.compile("(?<![\\p{L}\\p{N}.,+\\-−–—])([+\\-−–—]?\\s*\\d[\\d.,\\s]*)원");
    public Quote parse(String source,String url,String html,Request request){
        Document doc=Jsoup.parse(html,url);
        if(!gameMatches(url,request.game()))return quote(source,url,"",null,"NEEDS_REVIEW","게임 분류와 판매처 페이지 경로가 일치하지 않습니다.");
        try{
            if(!"SINGLE".equals(request.productType()))return source.equals("CARDNYANG")?sealedCardnyang(url,doc,request):sealedRolling(url,doc,request);
            if(request.unitCount()!=1)return quote(source,url,"",null,"NEEDS_REVIEW","싱글 묶음 수량을 검증할 수 없습니다.");
            return source.equals("ROLLING_DICE")?rolling(url,doc,request):cardnyang(url,doc,request);
        }
        catch(Exception ex){return quote(source,url,"",null,"NEEDS_REVIEW","상품 상세 구조 또는 옵션을 확인할 수 없습니다.");}
    }
    private boolean gameMatches(String url,String game){String path=URI.create(url).getPath();return path.startsWith("/fabtcg/")?Set.of("플레시 앤 블러드","플래시 앤 블러드","Flesh and Blood","FAB").contains(game):path.startsWith("/rbtcg/")?Set.of("리프트바운드","Riftbound").contains(game):path.startsWith("/mtg")&&Set.of("매직 더 개더링","Magic: The Gathering","MTG").contains(game);}
    private boolean unitMatches(String title,Request r){String n=normal(title);String kind=n.matches(".*(?:case|케이스).*")?"CASE":n.matches(".*(?:box|박스).*")?"BOX":n.matches(".*(?:pack|팩|booster$).*")?"PACK":n.matches(".*(?:deck|덱).*")?"DECK":"";if(!kind.equals(r.productType()))return false;var m=Pattern.compile("(?:^|[\\s(])(?:x\\s*(\\d+)|(\\d+)\\s*(?:팩|박스|덱|케이스|packs?|boxes|decks?))(?:$|[\\s)])",Pattern.CASE_INSENSITIVE).matcher(title);if(m.find())return Integer.parseInt(m.group(1)!=null?m.group(1):m.group(2))==r.unitCount();return r.unitCount()==1;}
    private Quote sealedCardnyang(String url,Document doc,Request r){
        var matched=new ArrayList<Element>();
        for(Element wrapper:doc.select(".product-image-wrapper")){
            Element info=wrapper.selectFirst(".single-products .productinfo"),choose=wrapper.selectFirst(".choose");if(info==null||choose==null)continue;
            var names=info.select("p");if(names.isEmpty())continue;String title=names.first().text();String set=names.size()>1?names.get(1).text():"";
            boolean name=normal(title).equals(normal(r.name()))||r.en()!=null&&!r.en().isBlank()&&normal(title).equals(normal(r.en()));
            boolean sameSet=set.isBlank()?normal(title).contains(normal(r.set())):normal(set).equals(normal(r.set()));
            if(name&&sameSet&&hasLanguage(choose,r.language()))matched.add(wrapper);
        }
        if(matched.size()!=1)return quote("CARDNYANG",url,"",null,"NEEDS_REVIEW","카테고리 내 동일 상품명·세트·언어가 하나로 확정되지 않습니다.");
        Element wrapper=matched.getFirst(),choose=wrapper.selectFirst(".choose");String title=wrapper.selectFirst(".productinfo p").text();
        if(!unitMatches(title,r)||!r.condition().equals("NM")||Pattern.compile("사전예약|예약|pre.?order|개봉|중고|손상",Pattern.CASE_INSENSITIVE).matcher(title).find())return quote("CARDNYANG",url,title,null,"NEEDS_REVIEW","밀봉 신품의 판매 단위 또는 컨디션이 일치하지 않거나 예약 상품입니다.");
        var stock=Pattern.compile("남은\\s*수량\\s*:\\s*(\\d+)개").matcher(choose.text());
        if(!stock.find()||Integer.parseInt(stock.group(1))<=0)return quote("CARDNYANG",url,title,null,"UNAVAILABLE","품절 또는 재고 미확인입니다.");
        return priced("CARDNYANG",url,title,choose.text());
    }
    private Quote sealedRolling(String url,Document doc,Request r){
        Element info=doc.select(".col-sm-8").stream().filter(e->e.selectFirst(".choose")!=null).findFirst().orElse(null);
        if(info==null)return quote("ROLLING_DICE",url,"",null,"NEEDS_REVIEW","밀봉 상품 상세 영역을 찾지 못했습니다.");
        var header=info.children().first();var parts=header.select(".col-sm-6");if(parts.size()!=2)return mismatch("ROLLING_DICE",url,"");String title=parts.first().text();
        if(!identity(title,parts.get(1).text().replaceAll("#.*$", "").trim(),r)||!unitMatches(title,r))return quote("ROLLING_DICE",url,title,null,"NEEDS_REVIEW","상품명·세트·판매 단위가 일치하지 않습니다.");
        // Some current FAB pages omit a language entirely. Never infer it from brand or country of origin.
        Element choose=info.selectFirst(".choose");var matches=choose.children().stream().filter(e->hasLanguage(e,r.language())).toList();
        if(matches.size()!=1)return quote("ROLLING_DICE",url,title,null,"NEEDS_REVIEW","페이지에 동일 언어 옵션이 명시되지 않았습니다.");
        if(!r.condition().equals("NM")||!info.text().contains("신상품")||Pattern.compile("사전예약|예약|pre.?order|개봉|중고|손상",Pattern.CASE_INSENSITIVE).matcher(title).find())return quote("ROLLING_DICE",url,title,null,"NEEDS_REVIEW","밀봉 신품 상태를 확인할 수 없습니다.");
        Element row=matches.getFirst();var stock=Pattern.compile("현재\\s*재고\\s*:\\s*(\\d+)").matcher(row.text());if(!stock.find()||Integer.parseInt(stock.group(1))<=0)return quote("ROLLING_DICE",url,title,null,"UNAVAILABLE","품절 또는 재고 미확인입니다.");return priced("ROLLING_DICE",url,title,row.children().first().text());
    }
    private Quote rolling(String url,Document doc,Request r){
        Element art=doc.select("img[src*=\"mtg-kr.com/cardimage/\"]").first();
        if(art==null)return quote("ROLLING_DICE",url,"",null,"NEEDS_REVIEW","상세 카드 이미지를 찾지 못했습니다.");
        Element info=art.parent().nextElementSibling();
        if(info==null)return quote("ROLLING_DICE",url,"",null,"NEEDS_REVIEW","상세 상품 영역이 없습니다.");
        Element header=info.children().first();
        String title=header.selectFirst(".col-sm-6").text();
        var setParts=header.select(".col-sm-6");
        if(setParts.size()!=2||!identity(title,setParts.get(1).text().replaceAll("#\\S+", "").trim(),r)||!codeMatches(art,url))return mismatch("ROLLING_DICE",url,title);
        Element choose=info.selectFirst(".choose");if(choose==null)return mismatch("ROLLING_DICE",url,title);
        var candidates=new ArrayList<Element>();
        for(Element row:choose.children()){
            Element value=row.children().first();if(value==null)continue;
            if(hasLanguage(value,r.language())&&value.select("img[src]").stream().anyMatch(i->basename(i.attr("src")).equals(r.condition()+".png"))&&!visibleFoil(value))candidates.add(row);
        }
        if(candidates.size()!=1)return quote("ROLLING_DICE",url,title,null,"NEEDS_REVIEW","일치하는 일반 카드 언어/컨디션 옵션이 하나로 확정되지 않습니다.");
        Element row=candidates.getFirst();String text=row.text();
        var stock=Pattern.compile("현재\\s*재고\\s*:\\s*(\\d+)").matcher(text);
        if(!stock.find()||Integer.parseInt(stock.group(1))<=0)return quote("ROLLING_DICE",url,title,null,"UNAVAILABLE","품절 또는 재고 미확인입니다.");
        return priced("ROLLING_DICE",url,title,row.children().first().text());
    }
    private Quote cardnyang(String url,Document doc,Request r){
        Element name=doc.selectFirst(".carddatainfo .cardname"),set=doc.selectFirst(".cardinfoetc .setname"),seller=doc.selectFirst(".cardinfoetc .cardsellerinfo"),art=doc.selectFirst(".cardimage img[src*=cardimage], .cardimg img[src*=cardimage], .cardinfo img[src*=cardimage]");
        if(art==null)art=doc.select("img[src*=\"mtg-kr.com/cardimage/\"]").first();
        String title=name==null?"":name.text();
        if(name==null||set==null||seller==null||art==null||!identity(title,set.text().replaceAll("#.*$", "").trim(),r)||!codeMatches(art,url))return mismatch("CARDNYANG",url,title);
        // The captured storefront places each language/condition/price in the direct anchor of a pagination li.
        var matches=new ArrayList<Element>();
        for(Element a:seller.select("ul.pagination > li > a")){
            String t=a.text();
            if(hasLanguage(a,r.language())&&Pattern.compile("(?<![A-Za-z])"+Pattern.quote(r.condition())+"(?![A-Za-z])").matcher(t).find()&&!visibleFoil(a))matches.add(a);
        }
        if(matches.size()!=1)return quote("CARDNYANG",url,title,null,"NEEDS_REVIEW","일치하는 일반 카드 언어/컨디션 옵션이 하나로 확정되지 않습니다.");
        String text=matches.getFirst().text();var stock=Pattern.compile("\\((\\d+)장\\)").matcher(text);
        if(!stock.find()||Integer.parseInt(stock.group(1))<=0)return quote("CARDNYANG",url,title,null,"UNAVAILABLE","품절 또는 재고 미확인입니다.");
        return priced("CARDNYANG",url,title,text);
    }
    private boolean codeMatches(Element art,String url){String query=URI.create(url).getQuery();String set=null,code=null;for(String p:query.split("&")){String[] a=p.split("=",2);if(a[0].equals("set"))set=a[1];if(a[0].equals("code"))code=a[1];}String file=basename(art.attr("src")).toLowerCase(Locale.ROOT);return file.startsWith((set+"-"+code+"-").toLowerCase(Locale.ROOT));}
    private boolean identity(String title,String set,Request r){return (normal(title).equals(normal(r.name()))||r.en()!=null&&!r.en().isBlank()&&normal(title).equals(normal(r.en())))&&normal(set).equals(normal(r.set()));}
    private String normal(String s){return Normalizer.normalize(Objects.toString(s,""),Normalizer.Form.NFKC).replaceAll("\\s+","").toLowerCase(Locale.ROOT);}
    private String basename(String value){String path=URI.create(value).getPath();return path.substring(path.lastIndexOf('/')+1);}
    private boolean hasLanguage(Element e,String language){String code=switch(language){case "한국어","한글","Korean"->"ko.png";case "영어","English"->"en.png";case "일본어","Japanese"->"jp.png";default->"";};return !code.isEmpty()&&e.select("img[src]").stream().anyMatch(i->(basename(i.attr("src")).equalsIgnoreCase(code)||code.equals("jp.png")&&basename(i.attr("src")).equalsIgnoreCase("ja.png")));}
    private boolean visibleFoil(Element e){return e.select("img[src*=foil]").stream().anyMatch(i->!i.attr("style").replace(" ","").matches(".*opacity:0(?:;.*)?"));}
    private Quote mismatch(String source,String url,String title){return quote(source,url,title,null,"NEEDS_REVIEW","상품명·세트·상품 코드가 일치하는 상세 페이지인지 확인하세요.");}
    private Quote priced(String source,String url,String title,String value){var m=MONEY.matcher(value);Long price=null;int count=0;while(m.find()){count++;String token=m.group(1).strip();if(!token.matches("(?:[0-9]+|[1-9][0-9]{0,2}(?:,[0-9]{3})+)"))return quote(source,url,title,null,"NEEDS_REVIEW","가격의 숫자 표기가 올바르지 않습니다.");try{price=Long.parseLong(token.replace(",",""));}catch(NumberFormatException ignored){}}if(count!=1||price==null||price<=0||price>1_000_000_000L)return quote(source,url,title,null,"NEEDS_REVIEW","양수의 단일 상품 가격이 아닙니다.");return quote(source,url,title,price,"READY","검증한 동일 상품·언어·컨디션·판매 단위 가격, 배송비 제외");}
}
