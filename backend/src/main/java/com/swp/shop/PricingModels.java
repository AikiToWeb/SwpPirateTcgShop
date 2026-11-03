package com.swp.shop;

import jakarta.validation.constraints.*;
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
        @Size(max=1200) String naverUrl,@Min(1) @Max(1000000000) Long naverManualPrice,
        Instant naverCheckedAt,boolean naverConfirmed){}
    public record Quote(String source,String url,String title,Long price,String status,String reason){}
    public record Result(String status,Long recommendedPrice,String selectedSource,Instant checkedAt,List<Quote> quotes,List<String> warnings){}
    public record Page(String html,Instant collectedAt){}
    public static Quote quote(String source,String url,String title,Long price,String status,String reason){return new Quote(source,url,title,price,status,reason);}
}
