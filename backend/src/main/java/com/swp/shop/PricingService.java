package com.swp.shop;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.time.*;
import java.util.*;
import org.springframework.stereotype.Service;
import static com.swp.shop.PricingModels.*;

@Service
public class PricingService {
    private final PricingPageClient client;
    private final PricingParser parser;
    private final ShopService shop;
    private final ObjectMapper json;
    private final Map<String,ArrayDeque<Long>> requests=new HashMap<>();
    public PricingService(PricingPageClient client,PricingParser parser,ShopService shop,ObjectMapper json){this.client=client;this.parser=parser;this.shop=shop;this.json=json;}
    public Result quote(String actor,Request request){
        limit(actor);
        List<Quote> quotes=new ArrayList<>();List<String>warnings=new ArrayList<>();
        List<Instant> collected=new ArrayList<>();
        quotes.add(source("ROLLING_DICE",request.rollingUrl(),request.rollingAbsent(),request,collected));
        quotes.add(source("CARDNYANG",request.cardnyangUrl(),request.cardnyangAbsent(),request,collected));
        boolean bothAbsent=quotes.stream().allMatch(q->q.status().equals("NOT_FOUND"));
        if(bothAbsent){
            quotes.addAll(naverReferences(request,collected));
            warnings.add("네이버 쇼핑 검색 API는 종료되어 자동 검색하지 않습니다.");
            if(quotes.stream().skip(2).anyMatch(q->q.status().equals("READY")))warnings.add("네이버 후보는 관리자가 동일 상품·언어·컨디션·상품 단위를 직접 확인해 입력한 수동 참조 가격입니다. 자동 조회가 아닙니다.");
        }else if((request.naverReferences()!=null&&!request.naverReferences().isEmpty())||request.naverConfirmed()||request.naverManualPrice()!=null||(request.naverUrl()!=null&&!request.naverUrl().isBlank()))warnings.add("두 기본 판매처 모두 미취급으로 확인되지 않아 네이버 수동 후보를 사용하지 않았습니다.");
        warnings.add("배송비 제외 상품 단위 가격입니다. 판매가에 자동 반영하지 않으며 수동 판매가를 덮어쓰지 않습니다.");
        String status="NO_MATCH";Long price=null;String selected=null,selectedUrl=null;
        List<Quote> relevant=bothAbsent?quotes.subList(2,quotes.size()):quotes;
        for(String blocked:List.of("NEEDS_MAPPING","UNAVAILABLE","CONFIG_REQUIRED","NEEDS_REVIEW"))if(relevant.stream().anyMatch(q->q.status().equals(blocked))){status=blocked;break;}
        if(status.equals("NO_MATCH")){
            Optional<Quote> best=relevant.stream().filter(q->q.status().equals("READY")&&q.price()!=null&&q.price()>0).min(Comparator.comparingLong(Quote::price));
            if(best.isPresent()){status="READY";price=best.get().price();selected=best.get().source();selectedUrl=best.get().url();}
        }
        // Cache entries keep their actual collection time. The oldest contributing observation defines freshness.
        Instant checked=collected.stream().min(Comparator.naturalOrder()).orElse(Instant.now());
        Result result=new Result(status,price,selected,checked,List.copyOf(quotes),List.copyOf(warnings),selectedUrl);
        // Preserve matching inputs, but never persist unvalidated raw URLs, query strings or credentials.
        var metadata=new LinkedHashMap<String,Object>();
        metadata.put("name",request.name());metadata.put("en",request.en());metadata.put("set",request.set());metadata.put("game",request.game());metadata.put("language",request.language());metadata.put("condition",request.condition());metadata.put("productType",request.productType());metadata.put("unitCount",request.unitCount());metadata.put("rollingAbsent",request.rollingAbsent());metadata.put("cardnyangAbsent",request.cardnyangAbsent());metadata.put("naverConfirmed",request.naverConfirmed());metadata.put("naverCheckedAt",request.naverCheckedAt());metadata.put("naverManualPrice",request.naverManualPrice());
        if(request.naverReferences()!=null){metadata.put("naverReferenceCount",request.naverReferences().size());metadata.put("naverReferences",request.naverReferences().stream().map(ref->{var item=new LinkedHashMap<String,Object>();if(ref!=null){item.put("price",ref.price());item.put("checkedAt",ref.checkedAt());item.put("confirmed",ref.confirmed());}return item;}).toList());}
        try{shop.jdbc.update("INSERT INTO price_reference_checks(id,actor_id,product_name,product_set,product_type,unit_count,status,recommended_price,selected_source,checked_at,result_json,request_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",UUID.randomUUID().toString(),actor,request.name(),request.set(),request.productType(),request.unitCount(),status,price,selected,checked.toString(),json.writeValueAsString(result),json.writeValueAsString(metadata));}
        catch(com.fasterxml.jackson.core.JsonProcessingException e){throw new IllegalStateException("가격 참조 결과를 기록하지 못했습니다.");}
        return result;
    }
    private synchronized void limit(String actor){long now=System.currentTimeMillis();var times=requests.computeIfAbsent(actor,k->new ArrayDeque<>());while(!times.isEmpty()&&times.getFirst()<now-60000)times.removeFirst();if(times.size()>=12)throw ShopService.error(429,"가격 참조는 분당 12회까지 가능합니다.");times.addLast(now);if(requests.size()>500)requests.entrySet().removeIf(e->e.getValue().isEmpty()||e.getValue().getLast()<now-60000);}
    private Quote source(String source,String url,boolean absent,Request request,List<Instant> collected){
        if(absent){if(url!=null&&!url.isBlank())return PricingModels.quote(source,null,"",null,"NEEDS_REVIEW","상세 URL과 미취급 확인을 동시에 선택할 수 없습니다.");return PricingModels.quote(source,null,"",null,"NOT_FOUND","관리자가 해당 판매처의 동일 상품 미취급을 확인했습니다.");}
        if(url==null||url.isBlank())return PricingModels.quote(source,null,"",null,"NEEDS_MAPPING","동일 상품 상세 URL 또는 미취급 확인이 필요합니다.");
        try{client.validated(source,url);}catch(IllegalArgumentException e){return PricingModels.quote(source,null,"",null,"NEEDS_MAPPING",e.getMessage());}
        try{var page=client.fetch(source,url);collected.add(page.collectedAt());return parser.parse(source,url,page.html(),request);}
        catch(Exception e){return PricingModels.quote(source,url,"",null,"UNAVAILABLE","판매처 통신·응답 검증에 실패했습니다. 미취급으로 간주하지 않습니다.");}
    }
    private Quote naver(Request r,List<Instant>collected){return naverReference(r.name(),new NaverReference(r.naverUrl(),r.naverManualPrice(),r.naverCheckedAt(),r.naverConfirmed()),collected,false,new HashSet<>());}
    private List<Quote> naverReferences(Request r,List<Instant> collected){
        if(r.naverReferences()==null||r.naverReferences().isEmpty())return List.of(naver(r,collected));
        if(r.naverReferences().size()>10)return List.of(PricingModels.quote("NAVER_SMARTSTORE",null,r.name(),null,"NEEDS_REVIEW","수동 참조는 최대 10개까지 가능합니다."));
        var seen=new HashSet<String>();return r.naverReferences().stream().map(ref->naverReference(r.name(),ref,collected,true,seen)).toList();
    }
    private Quote naverReference(String title,NaverReference ref,List<Instant>collected,boolean listed,Set<String>seen){
        if(ref==null)return PricingModels.quote("NAVER_SMARTSTORE",null,title,null,"NEEDS_REVIEW","수동 참조 항목을 확인하세요.");
        String url=ref.url();
        if(!ref.confirmed()||ref.price()==null||url==null||url.isBlank())return PricingModels.quote("NAVER_SMARTSTORE",null,title,null,listed?"NEEDS_REVIEW":"UNAVAILABLE","API_RETIRED: 자동 검색 API 종료. 동일 상품을 직접 확인한 스마트스토어 상품 URL·가격·시각·매칭 확인을 입력하세요.");
        try{URI uri=URI.create(url);if(!"https".equals(uri.getScheme())||!Set.of("smartstore.naver.com","brand.naver.com").contains(uri.getHost())||uri.getUserInfo()!=null||uri.getFragment()!=null||(uri.getPort()!=-1&&uri.getPort()!=443)||uri.getRawQuery()!=null||!uri.getPath().matches("/[A-Za-z0-9_-]+/products/[0-9]+"))throw new IllegalArgumentException();}
        catch(Exception e){return PricingModels.quote("NAVER_SMARTSTORE",null,title,null,"NEEDS_MAPPING","정확한 HTTPS 스마트스토어 상품 URL이 필요합니다.");}
        String canonical="https://"+URI.create(url).getHost()+URI.create(url).getPath();
        if(!seen.add(canonical))return PricingModels.quote("NAVER_SMARTSTORE",canonical,title,null,"NEEDS_REVIEW","같은 상품 URL을 중복 입력했습니다.");
        url=canonical;
        Instant now=Instant.now();if(ref.checkedAt()==null||ref.checkedAt().isAfter(now)||ref.checkedAt().isBefore(now.minusSeconds(86400)))return PricingModels.quote("NAVER_SMARTSTORE",url,title,null,"NEEDS_REVIEW","직접 확인 시각은 미래가 아닌 최근 24시간 이내여야 합니다.");
        if(ref.price()<=0||ref.price()>1_000_000_000L)return PricingModels.quote("NAVER_SMARTSTORE",url,title,null,"NEEDS_REVIEW","유효한 양수 가격이 필요합니다.");
        collected.add(ref.checkedAt());return PricingModels.quote("NAVER_SMARTSTORE",url,title,ref.price(),"READY","관리자 직접 확인: 동일 세트·언어·컨디션·상품 단위, 배송비 제외. 자동 조회 아님");
    }
}
