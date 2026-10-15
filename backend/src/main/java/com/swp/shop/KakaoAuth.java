package com.swp.shop;

import jakarta.servlet.http.HttpServletRequest;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Map;
import java.util.Objects;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.web.client.RestClient;
import org.springframework.web.util.UriComponentsBuilder;

@Service
public class KakaoAuth {
    private final ShopService s;
    private final String clientId,clientSecret;
    private final RestClient client;
    @Value("${SHOP_ADMIN_KAKAO_ID:}") private String adminId;
    public KakaoAuth(ShopService s,@Value("${KAKAO_REST_API_KEY:}") String clientId,@Value("${KAKAO_CLIENT_SECRET:}") String secret){
        this.s=s;this.clientId=clientId;this.clientSecret=secret;
        var factory=new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build());factory.setReadTimeout(Duration.ofSeconds(15));client=RestClient.builder().requestFactory(factory).build();
    }
    public boolean configured(){return !clientId.isBlank()&&!clientSecret.isBlank();}
    public String cookie(String name,String value,long seconds){return ResponseCookie.from(name,value).path("/shop-api").httpOnly(true).secure(s.origin.startsWith("https://")).sameSite("Lax").maxAge(seconds).build().toString();}
    public ResponseEntity<Void> login(){
        if(!configured())throw ShopService.error(503,"카카오 앱 설정이 필요합니다.");
        String state=s.token();s.jdbc.update("DELETE FROM oauth_states WHERE expires<?",s.now());s.jdbc.update("INSERT INTO oauth_states VALUES(?,?)",s.hash(state),s.now()+600);
        String url=UriComponentsBuilder.fromUriString("https://kauth.kakao.com/oauth/authorize").queryParam("client_id",clientId).queryParam("redirect_uri",s.origin+"/shop-api/auth/callback").queryParam("response_type","code").queryParam("state",state).build().encode().toUriString();
        return ResponseEntity.status(302).header(HttpHeaders.LOCATION,url).header(HttpHeaders.SET_COOKIE,cookie("swp_oauth",state,600)).build();
    }
    public ResponseEntity<Void> callback(HttpServletRequest req,String state,String code,String error){
        if(state.isEmpty()||!ShopService.equal(state,s.cookie(req,"swp_oauth")))throw ShopService.error(400,"로그인 요청이 유효하지 않습니다.");
        Boolean valid=s.tx.execute(status->{var rows=s.jdbc.queryForList("SELECT expires FROM oauth_states WHERE token=? FOR UPDATE",s.hash(state));s.jdbc.update("DELETE FROM oauth_states WHERE token=?",s.hash(state));return !rows.isEmpty()&&((Number)rows.getFirst().get("EXPIRES")).longValue()>s.now();});
        if(!Boolean.TRUE.equals(valid))throw ShopService.error(400,"로그인 요청이 만료되었습니다.");
        if(!error.isBlank()||code.isBlank())return failed();
        Map<?,?> account;
        try {
            var data=new LinkedMultiValueMap<String,String>();data.add("grant_type","authorization_code");data.add("client_id",clientId);data.add("client_secret",clientSecret);data.add("redirect_uri",s.origin+"/shop-api/auth/callback");data.add("code",code);
            Map<?,?> token=client.post().uri("https://kauth.kakao.com/oauth/token").contentType(MediaType.APPLICATION_FORM_URLENCODED).body(data).retrieve().body(Map.class);
            if(token==null||!token.containsKey("access_token"))return failed();
            account=client.get().uri("https://kapi.kakao.com/v2/user/me").header(HttpHeaders.AUTHORIZATION,"Bearer "+token.get("access_token")).retrieve().body(Map.class);
            if(account==null||!account.containsKey("id"))return failed();
        }catch(Exception ignored){return failed();} // Never log OAuth codes, provider tokens or credentials.
        String id=account.get("id").toString();String nickname="회원";
        if(account.get("properties") instanceof Map<?,?> props)nickname=Objects.toString(props.get("nickname"),"회원");
        String name=nickname.substring(0,Math.min(nickname.length(),80)),session=s.token(),csrf=s.token();
        s.tx.executeWithoutResult(status->{
            s.upsertUser(id,name);
            if(id.equals(adminId))s.jdbc.update("UPDATE shop_users SET role='ADMIN' WHERE id=?",id);
            s.jdbc.update("DELETE FROM sessions WHERE expires<? OR token=?",s.now(),s.hash(s.cookie(req,"swp_session")));
            s.jdbc.update("INSERT INTO sessions VALUES(?,?,?,?)",s.hash(session),id,csrf,s.now()+604800);
        });
        return ResponseEntity.status(303).header(HttpHeaders.LOCATION,s.origin+"/rolling.html?login=success").header(HttpHeaders.SET_COOKIE,cookie("swp_oauth","",0),cookie("swp_session",session,604800)).build();
    }
    private ResponseEntity<Void> failed(){return ResponseEntity.status(303).header(HttpHeaders.LOCATION,s.origin+"/rolling.html?login=failed").header(HttpHeaders.SET_COOKIE,cookie("swp_oauth","",0)).build();}
}
