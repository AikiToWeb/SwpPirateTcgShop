package com.swp.shop;

import jakarta.validation.constraints.*;
import jakarta.validation.Valid;
import java.time.Instant;
import java.util.List;

public final class PricingModels {
    private PricingModels(){}
    public record Request(@NotBlank @Size(max=200) String name,@Size(max=200) String en,
        @NotBlank @Size(max=200) String set,@NotBlank @Size(max=80) String game,
        @NotBlank @Size(max=30) String language,@NotBlank @Pattern(regexp="NM|EX|VG|G") String condition,
        @NotBlank @Pattern(regexp="SINGLE|PACK|BOX|DECK|CASE") String productType,@Min(1) @Max(1000) int unitCount,
        @Size(max=1200) String rollingUrl,@Size(max=1200) String cardnyangUrl,
        boolean rollingAbsent,boolean cardnyangAbsent,@Size(max=300) String naverQuery,
        String naverUrl,Long naverManualPrice,
        Instant naverCheckedAt,boolean naverConfirmed,
        @Size(max=10) List<@NotNull @Valid NaverReference> naverReferences){
        public Request(String name,String en,String set,String game,String language,String condition,String productType,int unitCount,String rollingUrl,String cardnyangUrl,boolean rollingAbsent,boolean cardnyangAbsent,String naverQuery,String naverUrl,Long naverManualPrice,Instant naverCheckedAt,boolean naverConfirmed){this(name,en,set,game,language,condition,productType,unitCount,rollingUrl,cardnyangUrl,rollingAbsent,cardnyangAbsent,naverQuery,naverUrl,naverManualPrice,naverCheckedAt,naverConfirmed,null);}
        @AssertTrue(message="네이버 수동 참조 입력값을 확인하세요.")
        public boolean isLegacyNaverValid(){return naverReferences!=null&&!naverReferences.isEmpty()||(naverUrl==null||naverUrl.length()<=1200)&&(naverManualPrice==null||naverManualPrice>=1&&naverManualPrice<=1_000_000_000L);}
    }
    public record NaverReference(@Size(max=1200) String url,@Min(1) @Max(1000000000) Long price,Instant checkedAt,boolean confirmed){}
    public record Quote(String source,String url,String title,Long price,String status,String reason){}
    public record Result(String status,Long recommendedPrice,String selectedSource,Instant checkedAt,List<Quote> quotes,List<String> warnings,String selectedUrl){
        public Result(String status,Long recommendedPrice,String selectedSource,Instant checkedAt,List<Quote> quotes,List<String> warnings){this(status,recommendedPrice,selectedSource,checkedAt,quotes,warnings,null);}
    }
    public record Page(String html,Instant collectedAt){}
    public static Quote quote(String source,String url,String title,Long price,String status,String reason){return new Quote(source,url,title,price,status,reason);}
}
