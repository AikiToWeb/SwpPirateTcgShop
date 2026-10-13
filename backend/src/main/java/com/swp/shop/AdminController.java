package com.swp.shop;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/shop-api/admin")
public class AdminController {
    private final ShopService s;
    public AdminController(ShopService s){this.s=s;}
    String admin(HttpServletRequest req,boolean write){String id=write?s.mutation(req):s.session(req,true).get("user_id").toString();if(!"ADMIN".equals(s.jdbc.queryForObject("SELECT role FROM shop_users WHERE id=?",String.class,id)))throw ShopService.error(403,"관리자 권한이 필요합니다.");return id;}
    public record Product(@NotBlank @Pattern(regexp="[A-Za-z0-9_-]{1,40}") String id,@NotBlank @Size(max=200) String name,@Size(max=200) String en,@NotBlank @Size(max=200) String set,@NotBlank @Size(max=80) String game,@NotBlank @Pattern(regexp="NM|EX|VG|G") String condition,@NotBlank @Size(max=30) String language,@Min(0) @Max(1000000000) long price,@Size(max=200) String image,@Min(0) @Max(1000000) Integer confirmedStock,boolean active){}
    public record Create(@Valid @NotNull Product product,@Min(0) @Max(1000000) int stock){}
    public record Stock(@Min(-1000000) @Max(1000000) int delta,@Min(0) int expectedStock,@NotBlank @Size(max=300) String reason){}
    public record Event(@NotBlank @Size(max=80) String game,@NotBlank @Size(max=200) String title,@NotNull LocalDateTime startsAt,@Size(max=1000) String description,boolean active){}
    public record Complete(@Pattern(regexp="수령완료") String status){}
    void validate(Product p){if(s.jdbc.queryForObject("SELECT COUNT(*) FROM games WHERE name=?",Integer.class,p.game())==0)throw ShopService.error(422,"게임 분류를 확인하세요.");if(p.image()!=null&&!p.image().isBlank()&&!p.image().matches("https://[^\\s]+|[A-Za-z0-9._-]+"))throw ShopService.error(422,"이미지는 HTTPS 주소 또는 파일명으로 입력하세요.");}
    @GetMapping("/summary") public Object summary(HttpServletRequest req){admin(req,false);var tables=new LinkedHashMap<String,Integer>();for(String table:List.of("games","cards","shop_users","sessions","oauth_states","binders","carts","shop_orders","order_items","stock_movements","shop_events","migration_history"))tables.put(table,s.jdbc.queryForObject("SELECT COUNT(*) FROM "+table,Integer.class));return Map.of("tables",tables,"products",s.jdbc.queryForObject("SELECT COUNT(*) FROM cards WHERE is_sample=FALSE",Integer.class),"sampleProducts",s.jdbc.queryForObject("SELECT COUNT(*) FROM cards WHERE is_sample=TRUE",Integer.class));}
    @GetMapping("/products") public Object products(HttpServletRequest req){admin(req,false);return s.jdbc.queryForList("SELECT * FROM cards ORDER BY is_sample,created DESC,id").stream().map(s::cardMap).toList();}
    @PostMapping("/products") public Object create(HttpServletRequest req,@Valid @RequestBody Create b){String actor=admin(req,true);validate(b.product());return s.tx.execute(tx->{var p=b.product();s.jdbc.update("INSERT INTO cards(id,name,en,set_name,price,stock,image,game,card_condition,language,created,active,is_sample) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,FALSE)",p.id(),p.name().trim(),Objects.toString(p.en(),""),p.set().trim(),p.price(),b.stock(),Objects.toString(p.image(),""),p.game(),p.condition(),p.language(),s.now(),p.active());s.movement(p.id(),actor,b.stock(),b.stock(),"상품 등록",null);return s.cardMap(s.jdbc.queryForMap("SELECT * FROM cards WHERE id=?",p.id()));});}
    @PutMapping("/products/{id}") public Object update(HttpServletRequest req,@PathVariable String id,@Valid @RequestBody Product p){String actor=admin(req,true);validate(p);if(!id.equals(p.id()))throw ShopService.error(422,"상품 코드가 일치하지 않습니다.");return s.tx.execute(tx->{
        var rows=s.jdbc.queryForList("SELECT * FROM cards WHERE id=? FOR UPDATE",id);if(rows.isEmpty())throw ShopService.error(404,"상품이 없습니다.");var row=rows.getFirst();boolean sample=Boolean.TRUE.equals(row.get("IS_SAMPLE"));
        if(sample&&p.confirmedStock()==null)throw ShopService.error(422,"예시 재고를 사용하지 않습니다. 확인한 실물 재고를 입력하세요.");
        s.jdbc.update("UPDATE cards SET name=?,en=?,set_name=?,price=?,image=?,game=?,card_condition=?,language=?,active=?,is_sample=FALSE,created=CASE WHEN created=0 THEN ? ELSE created END WHERE id=?",p.name().trim(),Objects.toString(p.en(),""),p.set().trim(),p.price(),Objects.toString(p.image(),""),p.game(),p.condition(),p.language(),p.active(),s.now(),id);
        if(sample){int old=((Number)row.get("STOCK")).intValue();s.jdbc.update("UPDATE cards SET stock=? WHERE id=?",p.confirmedStock(),id);s.movement(id,actor,p.confirmedStock()-old,p.confirmedStock(),"실물 확인 재고 등록",null);}
        return s.cardMap(s.jdbc.queryForMap("SELECT * FROM cards WHERE id=?",id));
    });}
    @PostMapping("/products/{id}/stock") public Object stock(HttpServletRequest req,@PathVariable String id,@Valid @RequestBody Stock b){String actor=admin(req,true);return s.tx.execute(tx->{var rows=s.jdbc.queryForList("SELECT * FROM cards WHERE id=? FOR UPDATE",id);if(rows.isEmpty())throw ShopService.error(404,"상품이 없습니다.");var r=rows.getFirst();if(Boolean.TRUE.equals(r.get("IS_SAMPLE")))throw ShopService.error(409,"예시 상품은 실제 상품 정보로 수정한 뒤 재고를 관리하세요.");int old=((Number)r.get("STOCK")).intValue(),next=old+b.delta();if(old!=b.expectedStock())throw ShopService.error(409,"주문 또는 재고 변경이 발생했습니다. 새로고침하세요.");if(next<0)throw ShopService.error(422,"재고는 음수가 될 수 없습니다.");s.jdbc.update("UPDATE cards SET stock=? WHERE id=?",next,id);s.movement(id,actor,b.delta(),next,b.reason().trim(),null);return Map.of("stock",next);});}
    @GetMapping("/movements") public Object movements(HttpServletRequest req){admin(req,false);return s.jdbc.queryForList("SELECT m.card_id,m.delta,m.balance,m.reason,m.order_id,m.created FROM stock_movements m ORDER BY m.id DESC LIMIT 100");}
    @GetMapping("/orders") public Object orders(HttpServletRequest req){admin(req,false);return s.jdbc.queryForList("SELECT * FROM shop_orders ORDER BY created DESC,id").stream().map(s::orderMap).toList();}
    @PostMapping("/orders/{id}/complete") public Object complete(HttpServletRequest req,@PathVariable String id){admin(req,true);if(s.jdbc.update("UPDATE shop_orders SET status='수령완료' WHERE id=? AND status='접수' AND is_sample=FALSE",id)==0)throw ShopService.error(409,"수령 완료할 접수 주문이 없습니다.");return Map.of("ok",true);}
    @GetMapping("/events") public Object events(HttpServletRequest req){admin(req,false);return s.jdbc.queryForList("SELECT id,game,title,starts_at,description,active,is_sample FROM shop_events ORDER BY starts_at DESC").stream().map(r->{r.put("STARTS_AT",r.get("STARTS_AT").toString().replace(" ","T").substring(0,16));return r;}).toList();}
    @PostMapping("/events") public Object event(HttpServletRequest req,@Valid @RequestBody Event e){admin(req,true);s.jdbc.update("INSERT INTO shop_events(game,title,starts_at,description,active,is_sample) VALUES(?,?,?,?,?,FALSE)",e.game(),e.title(),Timestamp.valueOf(e.startsAt()),Objects.toString(e.description(),""),e.active());return Map.of("ok",true);}
    @PutMapping("/events/{id}") public Object event(HttpServletRequest req,@PathVariable long id,@Valid @RequestBody Event e){admin(req,true);if(s.jdbc.update("UPDATE shop_events SET game=?,title=?,starts_at=?,description=?,active=?,is_sample=FALSE WHERE id=?",e.game(),e.title(),Timestamp.valueOf(e.startsAt()),Objects.toString(e.description(),""),e.active(),id)==0)throw ShopService.error(404,"일정이 없습니다.");return Map.of("ok",true);}
}
