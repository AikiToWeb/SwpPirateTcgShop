package com.swp.shop;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.validation.constraints.*;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class InventoryService {
    final ShopService s;
    private final ObjectMapper json;
    static final int MAX_STOCK=99_999_999;
    public record Stock(@NotBlank @Pattern(regexp="[A-Za-z0-9_-]{1,40}") String productId,
        @NotBlank @Pattern(regexp="IN|OUT|ADJUST") String type,@NotNull @Min(0) @Max(MAX_STOCK) Integer quantity,
        @NotBlank @Size(max=300) String reason,@NotNull @Min(0) Long expectedVersion,
        @NotBlank @Pattern(regexp="[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}") String operationId){}
    public InventoryService(ShopService s,ObjectMapper json){this.s=s;this.json=json;}
    static InventoryException error(int status,String code,String message){return new InventoryException(status,code,message);}
    static void paging(int limit,int offset){if(limit<1||limit>200||offset<0)throw error(422,"VALIDATION","조회 범위를 확인해 주세요.");}
    static String like(String query){if(query==null||query.length()>200||query.indexOf('\0')>=0)throw error(422,"VALIDATION","검색어는 200자 이내로 입력해 주세요.");return "%"+query.trim().toLowerCase(Locale.ROOT).replace("!","!!").replace("%","!%").replace("_","!_")+"%";}
    Map<String,Object> product(Map<String,Object> row){
        long created=((Number)row.get("CREATED")).longValue(),updated=((Number)row.get("INVENTORY_UPDATED")).longValue();
        return Map.ofEntries(Map.entry("id",row.get("ID")),Map.entry("sku",row.get("ID")),Map.entry("name",row.get("NAME")),
            Map.entry("setName",row.get("SET_NAME")),Map.entry("language",row.get("LANGUAGE")),Map.entry("condition",row.get("CARD_CONDITION")),
            Map.entry("unit","개"),Map.entry("stock",row.get("STOCK")),Map.entry("version",row.get("INVENTORY_VERSION")),
            Map.entry("createdAt",Instant.ofEpochSecond(created).toString()),Map.entry("updatedAt",Instant.ofEpochSecond(updated>0?updated:created).toString()));
    }
    Map<String,Object> find(String id,boolean lock){
        var rows=s.jdbc.queryForList("SELECT * FROM cards WHERE id=? AND is_sample=FALSE"+(lock?" FOR UPDATE":""),id);
        if(rows.isEmpty())throw error(404,"NOT_FOUND","상품이 없습니다. 기존 상점 관리에서 실제 상품을 등록해 주세요.");
        return rows.getFirst();
    }
    public Map<String,Object> products(String query,int limit,int offset){
        paging(limit,offset);String pattern=like(query);String where="is_sample=FALSE AND (LOWER(id) LIKE ? ESCAPE '!' OR LOWER(name) LIKE ? ESCAPE '!' OR LOWER(set_name) LIKE ? ESCAPE '!')";
        var items=s.jdbc.queryForList("SELECT * FROM cards WHERE "+where+" ORDER BY name,id LIMIT ? OFFSET ?",pattern,pattern,pattern,limit,offset).stream().map(this::product).toList();
        return Map.of("items",items,"total",s.jdbc.queryForObject("SELECT COUNT(*) FROM cards WHERE "+where,Long.class,pattern,pattern,pattern));
    }
    public Map<String,Object> overview(){
        return Map.of("productCount",s.jdbc.queryForObject("SELECT COUNT(*) FROM cards WHERE is_sample=FALSE",Long.class),
            "totalStock",s.jdbc.queryForObject("SELECT COALESCE(SUM(CAST(stock AS BIGINT)),0) FROM cards WHERE is_sample=FALSE",Long.class),
            "outOfStockCount",s.jdbc.queryForObject("SELECT COUNT(*) FROM cards WHERE is_sample=FALSE AND stock=0",Long.class),
            "movementCount",s.jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements m JOIN cards c ON c.id=m.card_id WHERE c.is_sample=FALSE",Long.class));
    }
    Map<String,Object> movement(Map<String,Object> row){
        var result=new LinkedHashMap<String,Object>();result.put("id",row.get("ID"));result.put("productId",row.get("CARD_ID"));result.put("sku",row.get("CARD_ID"));result.put("name",row.get("NAME"));
        result.put("type",row.get("INVENTORY_TYPE"));result.put("delta",row.get("DELTA"));result.put("beforeStock",((Number)row.get("BALANCE")).longValue()-((Number)row.get("DELTA")).longValue());
        result.put("afterStock",row.get("BALANCE"));result.put("reason",row.get("REASON"));result.put("createdAt",Instant.ofEpochSecond(((Number)row.get("CREATED")).longValue()).toString());result.put("operationId",row.get("OPERATION_ID"));return result;
    }
    public Map<String,Object> history(String productId,int limit,int offset){
        paging(limit,offset);var params=new ArrayList<Object>();String where="c.is_sample=FALSE";
        if(productId!=null&&!productId.isBlank()){find(productId,false);where+=" AND m.card_id=?";params.add(productId);}
        long total=s.jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements m JOIN cards c ON c.id=m.card_id WHERE "+where,Long.class,params.toArray());
        params.add(limit);params.add(offset);
        return Map.of("items",s.jdbc.queryForList("SELECT m.*,c.name FROM stock_movements m JOIN cards c ON c.id=m.card_id WHERE "+where+" ORDER BY m.id DESC LIMIT ? OFFSET ?",params.toArray()).stream().map(this::movement).toList(),"total",total);
    }
    public Map<String,Object> adjust(InventoryDeviceService.Device device,Stock body){return s.tx.execute(tx->{
        // Locking the device serializes same-device retries before consulting the operation key.
        var devices=s.jdbc.queryForList("SELECT d.id FROM inventory_devices d JOIN shop_users u ON u.id=d.actor_id WHERE d.id=? AND d.actor_id=? AND d.revoked=FALSE AND d.expires>? AND u.role='ADMIN' FOR UPDATE",device.id(),device.actorId(),s.now());
        if(devices.isEmpty())throw error(401,"UNAUTHORIZED","매장 연결이 해제되었습니다.");
        if(!body.type().equals("ADJUST")&&body.quantity()==0)throw error(422,"VALIDATION","입출고 수량은 1 이상이어야 합니다.");
        String operation=body.operationId().toLowerCase(Locale.ROOT),payload;
        try{payload=s.hash(json.writeValueAsString(List.of(body.productId(),body.type(),body.quantity(),body.reason().trim(),body.expectedVersion())));}catch(Exception e){throw new IllegalStateException("Cannot encode inventory operation");}
        var prior=s.jdbc.queryForList("SELECT * FROM inventory_operations WHERE operation_id=?",operation);
        if(!prior.isEmpty()){
            var row=prior.getFirst();if(!row.get("DEVICE_ID").equals(device.id())||!row.get("PAYLOAD_HASH").equals(payload))throw error(409,"CONFLICT","같은 작업 식별자로 다른 변경을 처리할 수 없습니다.");
            try{return json.readValue(row.get("RESULT_JSON").toString(),new com.fasterxml.jackson.core.type.TypeReference<Map<String,Object>>(){});}catch(Exception e){throw new IllegalStateException("Cannot read inventory operation");}
        }
        var row=find(body.productId(),true);long old=((Number)row.get("STOCK")).longValue(),version=((Number)row.get("INVENTORY_VERSION")).longValue();
        if(version!=body.expectedVersion())throw error(409,"CONFLICT","주문 또는 재고 변경이 발생했습니다. 최신 수량을 확인해 주세요.");
        long next=body.type().equals("ADJUST")?body.quantity():old+(body.type().equals("IN")?body.quantity():-body.quantity());
        if(next<0)throw error(409,"INSUFFICIENT_STOCK","현재 판매가능 재고보다 많이 출고할 수 없습니다.");
        if(next>MAX_STOCK)throw error(422,"VALIDATION","변경 후 재고는 99,999,999 이하여야 합니다.");
        if(next==old)throw error(422,"NO_CHANGE","현재 재고와 같은 수량입니다.");
        s.jdbc.update("UPDATE cards SET stock=? WHERE id=?",next,body.productId());
        s.movement(body.productId(),device.actorId(),(int)(next-old),(int)next,body.reason().trim(),null);
        var movement=s.jdbc.queryForMap("SELECT m.*,c.name FROM stock_movements m JOIN cards c ON c.id=m.card_id WHERE m.card_id=? ORDER BY m.id DESC LIMIT 1",body.productId());
        s.jdbc.update("UPDATE stock_movements SET inventory_type=?,operation_id=? WHERE id=?",body.type(),operation,movement.get("ID"));
        movement.put("INVENTORY_TYPE",body.type());movement.put("OPERATION_ID",operation);
        var result=Map.<String,Object>of("product",product(find(body.productId(),false)),"movement",movement(movement));
        try{s.jdbc.update("INSERT INTO inventory_operations(operation_id,device_id,payload_hash,result_json,created) VALUES(?,?,?,?,?)",operation,device.id(),payload,json.writeValueAsString(result),s.now());}catch(com.fasterxml.jackson.core.JsonProcessingException e){throw new IllegalStateException("Cannot save inventory operation");}
        return result;
    });}
}
