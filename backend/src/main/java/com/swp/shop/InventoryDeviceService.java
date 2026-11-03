package com.swp.shop;

import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class InventoryDeviceService {
    private final ShopService s;
    public record Device(String id,String actorId){}
    public InventoryDeviceService(ShopService s){this.s=s;}
    static String iso(long seconds){return Instant.ofEpochSecond(seconds).toString();}
    static void nativeRequest(HttpServletRequest req){if(req.getHeader("Origin")!=null)throw ShopService.error(403,"데스크톱 전용 요청입니다.");}
    public Map<String,Object> createPairing(String actor,String name){
        String code=s.token();long expires=s.now()+300;
        s.tx.executeWithoutResult(tx->{
            s.jdbc.update("DELETE FROM inventory_pairings WHERE expires<=?",s.now());
            s.jdbc.update("INSERT INTO inventory_pairings(code_hash,actor_id,device_name,expires) VALUES(?,?,?,?)",s.hash(code),actor,name.trim(),expires);
        });
        return Map.of("pairCode",code,"expiresAt",iso(expires));
    }
    public Map<String,Object> pair(String code,String name){return s.tx.execute(tx->{
        var rows=s.jdbc.queryForList("SELECT p.* FROM inventory_pairings p JOIN shop_users u ON u.id=p.actor_id WHERE p.code_hash=? AND p.expires>? AND u.role='ADMIN' FOR UPDATE",s.hash(code),s.now());
        if(rows.isEmpty())throw ShopService.error(401,"연결 코드가 만료되었거나 올바르지 않습니다.");
        var row=rows.getFirst();String id=UUID.randomUUID().toString(),token=s.token();long now=s.now(),expires=now+30L*24*3600;
        s.jdbc.update("DELETE FROM inventory_pairings WHERE code_hash=?",s.hash(code));
        s.jdbc.update("INSERT INTO inventory_devices(id,token_hash,actor_id,name,created,expires,revoked) VALUES(?,?,?,?,?,?,FALSE)",id,s.hash(token),row.get("ACTOR_ID"),name.trim(),now,expires);
        return Map.<String,Object>of("deviceToken",token,"expiresAt",iso(expires));
    });}
    public Device authenticate(HttpServletRequest req){
        nativeRequest(req);
        String header=Objects.toString(req.getHeader("Authorization"),"");
        if(!header.matches("Bearer [A-Za-z0-9_-]{43}"))throw ShopService.error(401,"매장 연결이 필요합니다.");
        var rows=s.jdbc.queryForList("SELECT d.id,d.actor_id FROM inventory_devices d JOIN shop_users u ON u.id=d.actor_id WHERE d.token_hash=? AND d.expires>? AND d.revoked=FALSE AND u.role='ADMIN'",s.hash(header.substring(7)),s.now());
        if(rows.isEmpty())throw ShopService.error(401,"매장 연결이 만료되었거나 해제되었습니다. 다시 연결해 주세요.");
        var row=rows.getFirst();return new Device(row.get("ID").toString(),row.get("ACTOR_ID").toString());
    }
    public Map<String,Object> devices(String actor){return Map.of("items",s.jdbc.queryForList("SELECT id,name,created,expires,revoked FROM inventory_devices WHERE actor_id=? ORDER BY created DESC,id",actor).stream()
        .map(row->Map.of("id",row.get("ID"),"name",row.get("NAME"),"createdAt",iso(((Number)row.get("CREATED")).longValue()),"expiresAt",iso(((Number)row.get("EXPIRES")).longValue()),"revoked",row.get("REVOKED"))).toList());}
    public Map<String,Object> revoke(String actor,String id){
        if(s.jdbc.update("UPDATE inventory_devices SET revoked=TRUE WHERE id=? AND actor_id=?",id,actor)==0)throw ShopService.error(404,"연결 기기가 없습니다.");
        return Map.of("ok",true);
    }
}
