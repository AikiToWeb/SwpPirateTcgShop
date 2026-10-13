package com.swp.shop;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/shop-api")
public class ShopController {
    private final ShopService service;
    private final KakaoAuth auth;
    public record Saved(boolean saved){}
    public ShopController(ShopService service,KakaoAuth auth){this.service=service;this.auth=auth;}
    @GetMapping("/health") public Map<String,Object> health(){return Map.of("status","ok","backend","Spring Boot","database","H2","kakao_configured",auth.configured());}
    @GetMapping("/cards") public Object cards(){return service.cards();}
    @GetMapping("/events") public Object events(){return service.events();}
    @GetMapping("/me") public Object me(HttpServletRequest req){var s=service.session(req,false);var result=new HashMap<String,Object>();result.put("user",s==null?null:Map.of("id",s.get("user_id"),"nickname",s.get("nickname")));result.put("csrf",s==null?null:s.get("csrf"));result.put("kakao_configured",auth.configured());return result;}
    @GetMapping("/auth/kakao") public ResponseEntity<Void> login(){return auth.login();}
    @GetMapping("/auth/callback") public ResponseEntity<Void> callback(HttpServletRequest req,@RequestParam(defaultValue="") String state,@RequestParam(defaultValue="") String code,@RequestParam(defaultValue="") String error){return auth.callback(req,state,code,error);}
    @PostMapping("/auth/logout") public ResponseEntity<?> logout(HttpServletRequest req){service.mutation(req);service.jdbc.update("DELETE FROM sessions WHERE token=?",service.hash(service.cookie(req,"swp_session")));return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE,auth.cookie("swp_session","",0)).body(Map.of("ok",true));}
    @GetMapping("/binder") public Object binder(HttpServletRequest req){return service.binder(service.session(req,true).get("user_id").toString());}
    @PutMapping("/binder/{id}") public Object save(HttpServletRequest req,@PathVariable String id,@RequestBody Saved body){service.save(service.mutation(req),id,body.saved());return Map.of("ok",true);}
    @GetMapping("/cart") public Object cart(HttpServletRequest req){return service.cart(service.session(req,true).get("user_id").toString());}
    @PutMapping("/cart") public Object cart(HttpServletRequest req,@Valid @RequestBody ShopService.Cart body){service.saveCart(service.mutation(req),body.items());return Map.of("ok",true);}
    @GetMapping("/orders") public Object orders(HttpServletRequest req){return service.orders(service.session(req,true).get("user_id").toString());}
    @PostMapping("/orders") @ResponseStatus(HttpStatus.CREATED) public Object checkout(HttpServletRequest req,@Valid @RequestBody ShopService.Checkout body){return service.checkout(service.mutation(req),body);}
    @PostMapping("/orders/{id}/cancel") public Object cancel(HttpServletRequest req,@PathVariable String id){return service.cancel(service.mutation(req),id);}
}
