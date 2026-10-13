package com.swp.shop;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ShopService {
    final JdbcTemplate jdbc;
    final TransactionTemplate tx;
    final String origin;
    private final SecureRandom random=new SecureRandom();
    public record Item(@NotBlank @Size(max=40) String id,@Min(1) @Max(100) int quantity){}
    public record Cart(@NotNull @Size(max=100) List<@Valid Item> items){}
    public record Checkout(@NotEmpty @Size(max=100) List<@Valid Item> items,@NotBlank @Size(min=16,max=80) String request_key){}
    public ShopService(JdbcTemplate jdbc,TransactionTemplate tx,@Value("${SHOP_ORIGIN:http://127.0.0.1:5175}") String origin){this.jdbc=jdbc;this.tx=tx;this.origin=origin.replaceAll("/$","");}
    public long now(){return Instant.now().getEpochSecond();}
    public String token(){byte[] b=new byte[32];random.nextBytes(b);return Base64.getUrlEncoder().withoutPadding().encodeToString(b);}
    public String hash(String value){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));}catch(Exception e){throw new IllegalStateException(e);}}
    public static boolean equal(String a,String b){return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8),b.getBytes(StandardCharsets.UTF_8));}
    public static ResponseStatusException error(int status,String message){return new ResponseStatusException(HttpStatus.valueOf(status),message);}
    public String cookie(HttpServletRequest req,String name){if(req.getCookies()!=null)for(var c:req.getCookies())if(c.getName().equals(name))return c.getValue();return "";}
    public Map<String,Object> session(HttpServletRequest req,boolean required){
        var list=jdbc.queryForList("SELECT s.user_id,s.csrf,u.nickname FROM sessions s JOIN shop_users u ON u.id=s.user_id WHERE token=? AND expires>?",hash(cookie(req,"swp_session")),now());
        if(list.isEmpty()){if(required)throw error(401,"로그인이 필요합니다.");return null;}
        var r=list.getFirst();return Map.of("user_id",r.get("USER_ID"),"csrf",r.get("CSRF"),"nickname",r.get("NICKNAME"));
    }
    public String mutation(HttpServletRequest req){
        if(!origin.equals(req.getHeader("Origin")))throw error(403,"허용되지 않은 요청입니다.");
        var s=session(req,true);
        if(!equal(Objects.toString(req.getHeader("X-CSRF-Token"),""),s.get("csrf").toString()))throw error(403,"요청을 다시 시도하세요.");
        return s.get("user_id").toString();
    }
    private Map<String,Object> cardMap(Map<String,Object> r){
        return Map.ofEntries(Map.entry("id",r.get("ID")),Map.entry("name",r.get("NAME")),Map.entry("en",r.get("EN")),Map.entry("set",r.get("SET_NAME")),Map.entry("price",r.get("PRICE")),Map.entry("stock",r.get("STOCK")),Map.entry("image",r.get("IMAGE")),Map.entry("game",r.get("GAME")),Map.entry("condition",r.get("CARD_CONDITION")),Map.entry("language",r.get("LANGUAGE")));
    }
    public List<Map<String,Object>> cards(){return jdbc.queryForList("SELECT * FROM cards ORDER BY created DESC,id").stream().map(this::cardMap).toList();}
    public List<Map<String,Object>> events(){return jdbc.queryForList("SELECT * FROM shop_events ORDER BY starts_at,id").stream().map(r->Map.<String,Object>of("id",r.get("ID"),"game",r.get("GAME"),"title",r.get("TITLE"),"startsAt",r.get("STARTS_AT").toString().replace(" ","T")+"+09:00","description",r.get("DESCRIPTION"),"sample",r.get("IS_SAMPLE"))).toList();}
    public List<String> binder(String user){return jdbc.queryForList("SELECT card_id FROM binders WHERE user_id=? ORDER BY card_id",String.class,user);}
    public void save(String user,String id,boolean saved){tx.executeWithoutResult(status->{lockUser(user);if(jdbc.queryForObject("SELECT COUNT(*) FROM cards WHERE id=?",Integer.class,id)==0)throw error(404,"상품이 없습니다.");if(saved)jdbc.update("MERGE INTO binders(user_id,card_id) KEY(user_id,card_id) VALUES(?,?)",user,id);else jdbc.update("DELETE FROM binders WHERE user_id=? AND card_id=?",user,id);});}
    public List<Map<String,Object>> cart(String user){return jdbc.queryForList("SELECT card_id,quantity FROM carts WHERE user_id=? ORDER BY card_id",user).stream().map(r->Map.<String,Object>of("id",r.get("CARD_ID"),"quantity",r.get("QUANTITY"))).toList();}
    private void lockUser(String user){jdbc.queryForObject("SELECT id FROM shop_users WHERE id=? FOR UPDATE",String.class,user);}
    private List<Item> validate(List<Item> items){
        if(items==null||items.size()>100||items.stream().map(Item::id).distinct().count()!=items.size())throw error(422,"중복 상품 또는 잘못된 장바구니입니다.");
        return items.stream().sorted(Comparator.comparing(Item::id)).toList();
    }
    public void saveCart(String user,List<Item> items){tx.executeWithoutResult(status->{lockUser(user);for(var i:validate(items)){var r=jdbc.queryForList("SELECT stock FROM cards WHERE id=? FOR UPDATE",i.id());if(r.isEmpty()||((Number)r.getFirst().get("STOCK")).intValue()<i.quantity())throw error(409,"재고가 변경되었습니다. 상품 목록을 갱신하세요.");}jdbc.update("DELETE FROM carts WHERE user_id=?",user);for(var i:items)jdbc.update("INSERT INTO carts VALUES(?,?,?)",user,i.id(),i.quantity());});}
    Map<String,Object> orderMap(Map<String,Object> r){
        var items=jdbc.queryForList("SELECT card_id,name,price,quantity FROM order_items WHERE order_id=? ORDER BY card_id",r.get("ID")).stream().map(i->Map.<String,Object>of("card_id",i.get("CARD_ID"),"name",i.get("NAME"),"price",i.get("PRICE"),"quantity",i.get("QUANTITY"))).toList();
        return Map.of("id",r.get("ID"),"status",r.get("STATUS"),"total",r.get("TOTAL"),"created",r.get("CREATED"),"items",items);
    }
    public List<Map<String,Object>> orders(String user){return jdbc.queryForList("SELECT * FROM shop_orders WHERE user_id=? ORDER BY created DESC,id DESC",user).stream().map(this::orderMap).toList();}
    public Map<String,Object> checkout(String user,Checkout body){return tx.execute(status->{
        lockUser(user);
        var prior=jdbc.queryForList("SELECT * FROM shop_orders WHERE user_id=? AND request_key=?",user,body.request_key());
        if(!prior.isEmpty())return orderMap(prior.getFirst());
        var items=validate(body.items());
        long total=0;
        var cards=new HashMap<String,Map<String,Object>>();
        for(var i:items){var r=jdbc.queryForList("SELECT * FROM cards WHERE id=? FOR UPDATE",i.id());if(r.isEmpty()||((Number)r.getFirst().get("STOCK")).intValue()<i.quantity())throw error(409,"재고가 부족합니다. 상품 목록을 갱신하세요.");cards.put(i.id(),r.getFirst());total+=((Number)r.getFirst().get("PRICE")).longValue()*i.quantity();}
        String id="SWP-"+UUID.randomUUID().toString().replace("-","").substring(0,12).toUpperCase(Locale.ROOT);
        jdbc.update("INSERT INTO shop_orders VALUES(?,?,?,?,?,?)",id,user,body.request_key(),"접수",total,now());
        for(var i:items){var p=cards.get(i.id());jdbc.update("UPDATE cards SET stock=stock-? WHERE id=?",i.quantity(),i.id());jdbc.update("INSERT INTO order_items VALUES(?,?,?,?,?)",id,i.id(),p.get("NAME"),p.get("PRICE"),i.quantity());}
        jdbc.update("DELETE FROM carts WHERE user_id=?",user);
        return orderMap(jdbc.queryForMap("SELECT * FROM shop_orders WHERE id=?",id));
    });}
    public Map<String,Object> cancel(String user,String id){return tx.execute(status->{
        lockUser(user);
        var rows=jdbc.queryForList("SELECT * FROM shop_orders WHERE id=? AND user_id=? FOR UPDATE",id,user);
        if(rows.isEmpty())throw error(404,"주문이 없습니다.");
        var row=rows.getFirst();if(row.get("STATUS").equals("취소"))return orderMap(row);
        if(!row.get("STATUS").equals("접수"))throw error(409,"취소할 수 없는 주문입니다.");
        for(var i:jdbc.queryForList("SELECT card_id,quantity FROM order_items WHERE order_id=? ORDER BY card_id",id))jdbc.update("UPDATE cards SET stock=stock+? WHERE id=?",i.get("QUANTITY"),i.get("CARD_ID"));
        jdbc.update("UPDATE shop_orders SET status='취소' WHERE id=?",id);
        return orderMap(jdbc.queryForMap("SELECT * FROM shop_orders WHERE id=?",id));
    });}
}
