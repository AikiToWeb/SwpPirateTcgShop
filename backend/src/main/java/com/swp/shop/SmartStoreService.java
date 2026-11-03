package com.swp.shop;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.*;
import java.time.*;
import java.util.*;
import java.util.function.Function;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class SmartStoreService {
    final ShopService s;
    final InventoryService inventory;
    final SmartStoreClient client;
    final boolean enabled;
    @Value("${SMARTSTORE_AUTO_SYNC_ENABLED:false}") private boolean autoEnabled;
    private String scheduledAfter="";
    public record Mapping(@NotBlank @Pattern(regexp="[A-Za-z0-9_-]{1,40}") String productId,
        @NotBlank @Pattern(regexp="[1-9][0-9]{0,18}") String originProductNo,@Pattern(regexp="[1-9][0-9]{0,18}") String optionId,
        @NotNull @Min(0) Long expectedVersion,@NotNull @AssertTrue Boolean confirmIdentity){}
    public record Baseline(@NotNull @Min(0) Long expectedVersion,@NotNull @Min(0) @Max(InventoryService.MAX_STOCK) Integer confirmedStock,
        @NotNull @AssertTrue Boolean confirmOutstandingOrdersIncluded){}
    public record Sync(@Size(max=20) List<@NotBlank @Pattern(regexp="[A-Za-z0-9_-]{1,40}") String> productIds){}
    public SmartStoreService(ShopService s,InventoryService inventory,SmartStoreClient client,@Value("${SMARTSTORE_SYNC_ENABLED:false}") boolean enabled){this.s=s;this.inventory=inventory;this.client=client;this.enabled=enabled;}
    private static String iso(long epoch){return Instant.ofEpochSecond(epoch).toString();}
    private static long number(Map<String,Object> row,String key){return ((Number)row.get(key)).longValue();}
    private static String option(Map<String,Object> row){return row.get("OPTION_ID").toString();}
    private Map<String,Object> mapping(String productId){var rows=s.jdbc.queryForList("SELECT * FROM smartstore_mappings WHERE card_id=?",productId);if(rows.isEmpty())throw InventoryService.error(404,"NOT_FOUND","스마트스토어 상품 연결이 없습니다.");return rows.getFirst();}
    public Map<String,Object> status(){
        var result=new LinkedHashMap<String,Object>();result.put("configured",client.configured());result.put("connected",client.connected());result.put("syncEnabled",enabled);
        Long last=s.jdbc.queryForObject("SELECT MAX(last_synced) FROM smartstore_mappings",Long.class);result.put("lastSyncAt",last==null?null:iso(last));
        result.put("autoSyncEnabled",autoEnabled&&enabled);result.put("message",!client.configured()?"서버에 스마트스토어 API 설정이 필요합니다.":!enabled?"상품 조회·연결과 주문 확인이 가능합니다. 네이버 재고 전송은 비활성화되어 있습니다.":"전송 설정이 켜져 있습니다. 상품별 초기 기준·주문·충돌 검사를 통과해야 반영됩니다.");return result;
    }
    public Map<String,Object> probeStatus(){
        if(client.configured())try{client.search(1);}catch(SmartStoreClient.Failure failure){client.disconnected();var result=status();result.put("message",failure.getMessage());return result;}
        return status();
    }
    private List<Map<String,Object>> options(JsonNode detail){
        var result=new ArrayList<Map<String,Object>>();var info=detail.path("originProduct").path("detailAttribute").path("optionInfo");
        for(String key:List.of("optionCombinations","optionStandards"))for(var row:info.path(key)){
            String id=SmartStoreClient.identifier(row.path("id"));var names=new ArrayList<String>();
            for(String field:List.of("optionName1","optionName2","optionName3","optionName"))if(row.path(field).isTextual()&&!row.path(field).asText().isBlank())names.add(row.path(field).asText());
            result.add(Map.of("optionId",id,"name",String.join(" / ",names),"stock",SmartStoreClient.stock(row.path("stockQuantity"))));
        }return result;
    }
    private int remoteStock(JsonNode detail,String optionId){
        var choices=options(detail);
        if(optionId==null||optionId.isBlank()){
            if(!choices.isEmpty())throw new SmartStoreClient.Failure("FAILED","옵션 상품은 정확한 옵션 번호를 선택해 연결해 주세요.");
            return SmartStoreClient.stock(detail.path("originProduct").path("stockQuantity"));
        }
        var info=detail.path("originProduct").path("detailAttribute").path("optionInfo");
        if(info.path("useStockManagement").isBoolean()&&!info.path("useStockManagement").asBoolean())throw new SmartStoreClient.Failure("FAILED","네이버 옵션 재고 관리가 꺼져 있습니다. 판매자센터에서 확인해 주세요.");
        for(var row:choices)if(optionId.equals(row.get("optionId")))return (Integer)row.get("stock");
        throw new SmartStoreClient.Failure("FAILED","선택한 네이버 옵션을 찾을 수 없습니다.");
    }
    public Map<String,Object> products(String query,int page){
        InventoryService.like(query);var response=client.search(page);var items=new ArrayList<Map<String,Object>>();
        for(var row:response.path("contents")){
            String origin=SmartStoreClient.identifier(row.path("originProductNo"));String channel=null;
            for(var c:row.path("channelProducts"))if("STOREFARM".equals(c.path("channelServiceType").asText())){channel=SmartStoreClient.identifier(c.path("channelProductNo"));break;}
            if(channel==null)continue;
            var detail=client.detail(origin);String name=detail.path("originProduct").path("name").asText();
            if(!name.toLowerCase(Locale.ROOT).contains(query.trim().toLowerCase(Locale.ROOT))&&!origin.contains(query.trim()))continue;
            items.add(Map.of("originProductNo",origin,"channelProductNo",channel,"name",name,"stock",SmartStoreClient.stock(detail.path("originProduct").path("stockQuantity")),"status",detail.path("originProduct").path("statusType").asText(),"options",options(detail)));
        }
        return Map.of("items",items,"total",response.path("totalElements").asLong(),"page",page,"pageSize",20,"message","상품명은 현재 페이지 내에서 필터링합니다. 다음 페이지도 확인해 주세요.");
    }
    private Map<String,Object> mappedItem(Map<String,Object> row){
        var result=new LinkedHashMap<String,Object>();result.put("productId",row.get("CARD_ID"));result.put("originProductNo",row.get("ORIGIN_PRODUCT_NO"));result.put("optionId",option(row).isBlank()?null:option(row));result.put("status",row.get("STATUS"));
        result.put("localStock",inventory.find(row.get("CARD_ID").toString(),false).get("STOCK"));result.put("remoteStock",row.get("REMOTE_STOCK"));result.put("lastSyncedAt",row.get("LAST_SYNCED")==null?null:iso(number(row,"LAST_SYNCED")));result.put("message",row.get("MESSAGE"));result.put("baselineVerified",row.get("BASELINE_VERIFIED"));return result;
    }
    public Map<String,Object> mappings(){return Map.of("items",s.jdbc.queryForList("SELECT * FROM smartstore_mappings ORDER BY card_id").stream().map(this::mappedItem).toList());}
    /** A DB lease covers HTTP work without holding database transactions open during external calls. */
    private synchronized <T> T locked(Function<String,T> action){
        String lease=UUID.randomUUID().toString();
        if(s.jdbc.update("UPDATE smartstore_sync_lock SET owner=?,expires=? WHERE id=1 AND expires<=?",lease,s.now()+120,s.now())!=1)throw InventoryService.error(409,"CONFLICT","다른 스마트스토어 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.");
        try{return action.apply(lease);}finally{s.jdbc.update("UPDATE smartstore_sync_lock SET owner=NULL,expires=0 WHERE id=1 AND owner=?",lease);}
    }
    private void renew(String lease){if(s.jdbc.update("UPDATE smartstore_sync_lock SET expires=? WHERE id=1 AND owner=? AND expires>?",s.now()+120,lease,s.now())!=1)throw InventoryService.error(409,"CONFLICT","동기화 작업 시간이 만료되었습니다. 결과를 확인한 뒤 다시 시도해 주세요.");}
    public Map<String,Object> map(InventoryDeviceService.Device actor,Mapping body){return locked(lease->{
        inventory.find(body.productId(),false);var detail=client.detail(body.originProductNo());renew(lease);int remote=remoteStock(detail,body.optionId());String channel=client.channelNumber(body.originProductNo());renew(lease);
        s.tx.executeWithoutResult(tx->{
            var product=inventory.find(body.productId(),true);if(number(product,"INVENTORY_VERSION")!=body.expectedVersion())throw InventoryService.error(409,"CONFLICT","상품 재고가 변경되었습니다. 새로고침해 주세요.");
            var old=s.jdbc.queryForList("SELECT * FROM smartstore_mappings WHERE card_id=? FOR UPDATE",body.productId());String option=Objects.toString(body.optionId(),"");
            if(!old.isEmpty()){
                var previous=old.getFirst();if(previous.get("ORIGIN_PRODUCT_NO").equals(body.originProductNo())&&option(previous).equals(option))return;
                if(Boolean.TRUE.equals(previous.get("BASELINE_VERIFIED"))||previous.get("STATUS").equals("UNKNOWN"))throw InventoryService.error(409,"CONFLICT","기준이 확정되었거나 결과가 불명확한 연결은 재지정할 수 없습니다. 이력을 검토해 주세요.");
                s.jdbc.update("DELETE FROM smartstore_mappings WHERE card_id=?",body.productId());
            }
            s.jdbc.update("INSERT INTO smartstore_mappings(card_id,origin_product_no,channel_product_no,option_id,actor_id,status,remote_stock,baseline_at,baseline_verified,orders_caught_up,message) VALUES(?,?,?,?,?,'BLOCKED',?,?,FALSE,FALSE,?)",body.productId(),body.originProductNo(),channel,option,actor.actorId(),remote,s.now(),"초기 재고 기준과 기존 미출고 주문 포함 여부를 확인해 주세요.");
        });return mappedItem(mapping(body.productId()));
    });}
    private Map<String,Object> item(String product,String state,String message){return Map.of("productId",product,"status",state,"message",message);}
    private Map<String,Object> mark(String product,String state,String message){s.jdbc.update("UPDATE smartstore_mappings SET status=?,message=? WHERE card_id=?",state,message,product);return item(product,state,message);}
    public Map<String,Object> baseline(InventoryDeviceService.Device actor,String productId,Baseline body){return locked(lease->{
        var before=inventory.find(productId,false);var map=mapping(productId);
        if(number(before,"INVENTORY_VERSION")!=body.expectedVersion()||number(before,"STOCK")!=body.confirmedStock())throw InventoryService.error(409,"CONFLICT","확인 수량과 현재 판매가능 재고가 다릅니다.");
        if(map.get("STATUS").equals("UNKNOWN"))return mark(productId,"UNKNOWN","이전 전송 결과를 먼저 확인해야 합니다. 기준을 다시 설정할 수 없습니다.");
        if(Boolean.TRUE.equals(map.get("BASELINE_VERIFIED")))return mark(productId,"BLOCKED","이미 기준이 확정된 연결입니다. 기존 주문 효과를 덮어쓰지 않습니다.");
        long point=s.now();String from=iso(point-86400),to=iso(point-5),sequence=null;int pages=0;
        do{
            renew(lease);var feed=client.changes(from,to,sequence);var ids=new ArrayList<String>();for(var change:feed.path("lastChangeStatuses"))ids.add(change.path("productOrderId").asText());
            if(!ids.isEmpty()){
                renew(lease);var details=client.orderDetails(ids);verifyDetails(ids,details);
                for(var entry:details)if(matches(map,entry.path("productOrder")))return mark(productId,"BLOCKED","최근 24시간에 연결 상품의 주문이 있습니다. 기존 주문의 예약·취소·반품을 먼저 검토해야 초기 기준을 확정할 수 있습니다.");
            }
            var more=feed.path("more");if(more.isMissingNode()||more.isNull())break;
            String next=more.path("moreFrom").asText(),seq=more.path("moreSequence").asText();if(next.isBlank()||seq.isBlank()||(next.equals(from)&&seq.equals(sequence)))throw new SmartStoreClient.Failure("FAILED","네이버 주문 페이지 진행을 확인할 수 없습니다.");
            from=next;sequence=seq;if(++pages>=10)return mark(productId,"BLOCKED","주문 확인 범위가 큽니다. 기존 주문 검토가 필요합니다.");
        }while(true);
        renew(lease);int remote=remoteStock(client.detail(map.get("ORIGIN_PRODUCT_NO").toString()),option(map));
        if(remote!=body.confirmedStock())return mark(productId,"CONFLICT","네이버 재고와 확인한 판매가능 재고가 다릅니다. 수량과 미출고 주문을 확인해 주세요.");
        s.tx.executeWithoutResult(tx->{var current=inventory.find(productId,true);if(number(current,"INVENTORY_VERSION")!=body.expectedVersion()||number(current,"STOCK")!=body.confirmedStock())throw InventoryService.error(409,"CONFLICT","검토 중 재고가 변경되었습니다. 다시 확인해 주세요.");
            s.jdbc.update("UPDATE smartstore_mappings SET baseline_at=?,baseline_verified=TRUE,order_cursor=?,order_sequence=NULL,orders_caught_up=FALSE,remote_stock=?,status='PENDING',message=? WHERE card_id=?",point,to,remote,"초기 기준을 확인했습니다. 주문 수집 후 재고 전송 조건을 검사합니다.",productId);
        });return mappedItem(mapping(productId));
    });}
    private static boolean matches(Map<String,Object> map,JsonNode order){
        String option=order.path("optionCode").asText("");if(option.equals("0"))option="";
        return map.get("CHANNEL_PRODUCT_NO").toString().equals(order.path("productId").asText())&&option(map).equals(option);
    }
    private static void verifyDetails(List<String> ids,JsonNode details){
        var expected=new HashSet<>(ids);var actual=new HashSet<String>();for(var entry:details)actual.add(entry.path("productOrder").path("productOrderId").asText());
        if(!expected.equals(actual)||details.size()!=actual.size())throw new SmartStoreClient.Failure("FAILED","일부 주문 상세가 누락되었습니다. 재고 전송을 중단합니다.");
    }
    private void applyOrder(Map<String,Object> map,JsonNode entry,String changedAt){
        var order=entry.path("productOrder");if(!matches(map,order))return;
        String card=map.get("CARD_ID").toString(),id=order.path("productOrderId").asText(),state=order.path("productOrderStatus").asText();
        if(id.isBlank()||id.length()>50||!order.path("quantity").isIntegralNumber()||!order.path("quantity").canConvertToInt()||order.path("quantity").asInt()<1||order.path("quantity").asInt()>InventoryService.MAX_STOCK)throw new SmartStoreClient.Failure("BLOCKED","주문 수량 또는 식별자를 확인할 수 없습니다.");
        int quantity=order.path("quantity").asInt();String claim=order.path("claimType").asText("");
        if((!claim.isBlank()&&!state.equals("CANCELED"))||entry.path("completedClaims").size()>0||entry.path("currentClaim").hasNonNull("return")||entry.path("currentClaim").hasNonNull("exchange"))throw new SmartStoreClient.Failure("BLOCKED","취소 진행·수량 클레임·반품·교환 주문은 수동 검토가 필요합니다.");
        if(order.has("initialQuantity")&&order.path("initialQuantity").asInt()!=quantity)throw new SmartStoreClient.Failure("BLOCKED","부분 수량 변경 주문은 수동 검토가 필요합니다.");
        var prior=s.jdbc.queryForList("SELECT * FROM smartstore_order_effects WHERE product_order_id=? FOR UPDATE",id);
        int previous=prior.isEmpty()?0:((Number)prior.getFirst().get("APPLIED_QUANTITY")).intValue();
        if(!prior.isEmpty()&&!prior.getFirst().get("CARD_ID").equals(card))throw new SmartStoreClient.Failure("CONFLICT","주문 상품 연결이 변경되었습니다.");
        if(!prior.isEmpty()&&((Number)prior.getFirst().get("QUANTITY")).intValue()!=quantity)throw new SmartStoreClient.Failure("BLOCKED","기존 주문의 수량이 변경되었습니다. 수동 검토가 필요합니다.");
        int desired;
        if(List.of("PAYED","DELIVERING","DELIVERED","PURCHASE_DECIDED").contains(state)){
            if(prior.isEmpty()){
                try{if(OffsetDateTime.parse(entry.path("order").path("paymentDate").asText()).toEpochSecond()<=number(map,"BASELINE_AT"))throw new SmartStoreClient.Failure("BLOCKED","초기 기준 이전 주문의 재고 효과를 확인할 수 없습니다.");}
                catch(java.time.format.DateTimeParseException e){throw new SmartStoreClient.Failure("BLOCKED","주문 결제 시각을 확인할 수 없어 재고 전송을 중단합니다.");}
            }desired=quantity;
        }else if(state.equals("CANCELED")){
            if(prior.isEmpty())throw new SmartStoreClient.Failure("BLOCKED","차감 이력이 없는 취소 주문은 자동 복구하지 않습니다.");desired=0;
        }else if(List.of("PAYMENT_WAITING","CANCELED_BY_NOPAYMENT").contains(state)){
            if(previous!=0)throw new SmartStoreClient.Failure("BLOCKED","기존 주문 효과와 현재 상태가 다릅니다.");desired=0;
        }else throw new SmartStoreClient.Failure("BLOCKED","지원하지 않는 주문·반품 상태입니다. 수동 검토가 필요합니다.");
        int delta=previous-desired;var current=inventory.find(card,true);long next=number(current,"STOCK")+delta;
        if(next<0||next>InventoryService.MAX_STOCK)throw new SmartStoreClient.Failure("CONFLICT","온라인 주문 반영 시 재고가 부족하거나 범위를 초과합니다. 수동 대사가 필요합니다.");
        if(delta!=0){
            s.jdbc.update("UPDATE cards SET stock=? WHERE id=?",next,card);
            s.movement(card,map.get("ACTOR_ID").toString(),delta,(int)next,delta<0?"스마트스토어 주문 예약":"스마트스토어 주문 취소",id);
            s.jdbc.update("UPDATE smartstore_mappings SET remote_stock=remote_stock+? WHERE card_id=?",delta,card);
        }
        if(prior.isEmpty())s.jdbc.update("INSERT INTO smartstore_order_effects(product_order_id,card_id,quantity,applied_quantity,order_status,changed_at) VALUES(?,?,?,?,?,?)",id,card,quantity,desired,state,changedAt);
        else s.jdbc.update("UPDATE smartstore_order_effects SET applied_quantity=?,order_status=?,changed_at=? WHERE product_order_id=?",desired,state,changedAt,id);
    }
    private boolean collectOrders(Map<String,Object> map,String lease){
        String product=map.get("CARD_ID").toString(),from=Objects.toString(map.get("ORDER_CURSOR"),iso(number(map,"BASELINE_AT"))),sequence=Objects.toString(map.get("ORDER_SEQUENCE"),null);long target=s.now()-5;
        for(int page=0;page<10;page++){
            long start=OffsetDateTime.parse(from).toEpochSecond();if(start>=target)return true;
            String until=iso(Math.min(target,start+86400));renew(lease);var feed=client.changes(from,until,sequence);var ids=new ArrayList<String>();var times=new HashMap<String,String>();
            for(var change:feed.path("lastChangeStatuses")){String id=change.path("productOrderId").asText();ids.add(id);times.put(id,change.path("lastChangedDate").asText(until));}
            JsonNode details=null;if(!ids.isEmpty()){renew(lease);details=client.orderDetails(ids);verifyDetails(ids,details);}
            var more=feed.path("more");String next,nextSequence;
            if(more.isMissingNode()||more.isNull()){next=until;nextSequence=null;}else{next=more.path("moreFrom").asText();nextSequence=more.path("moreSequence").asText();if(next.isBlank()||nextSequence.isBlank()||(next.equals(from)&&nextSequence.equals(sequence)))throw new SmartStoreClient.Failure("FAILED","주문 페이지를 이어 읽을 수 없습니다.");}
            var records=details;String cursor=next,cursorSequence=nextSequence;
            s.tx.executeWithoutResult(tx->{
                inventory.find(product,true);
                if(records!=null)for(var entry:records)applyOrder(mapping(product),entry,times.get(entry.path("productOrder").path("productOrderId").asText()));
                s.jdbc.update("UPDATE smartstore_mappings SET order_cursor=?,order_sequence=?,orders_caught_up=? WHERE card_id=?",cursor,cursorSequence,cursorSequence==null&&OffsetDateTime.parse(cursor).toEpochSecond()>=target,product);
            });
            from=next;sequence=nextSequence;if(sequence==null&&OffsetDateTime.parse(from).toEpochSecond()>=target)return true;
        }return false;
    }
    public Map<String,Object> sync(InventoryDeviceService.Device actor,List<String> requested){return locked(lease->{
        var ids=requested==null||requested.isEmpty()?s.jdbc.queryForList("SELECT card_id FROM smartstore_mappings ORDER BY card_id LIMIT 21",String.class):requested.stream().distinct().sorted().toList();
        if(ids.size()>20)throw InventoryService.error(422,"VALIDATION","한 번에 최대 20개 상품을 선택해 주세요.");
        var items=new ArrayList<Map<String,Object>>();
        for(String id:ids){
            if(!client.configured()){items.add(item(id,"NOT_CONFIGURED","서버에 스마트스토어 API 설정이 필요합니다."));continue;}
            var existing=s.jdbc.queryForList("SELECT * FROM smartstore_mappings WHERE card_id=?",id);
            if(existing.isEmpty()){items.add(item(id,"BLOCKED","스마트스토어 상품을 먼저 연결해 주세요."));continue;}
            var map=existing.getFirst();
            if(s.jdbc.queryForObject("SELECT COUNT(*) FROM shop_users WHERE id=? AND role='ADMIN'",Integer.class,map.get("ACTOR_ID"))!=1){items.add(mark(id,"BLOCKED","연결을 등록한 관리자의 권한이 해제되었습니다."));continue;}
            if(map.get("STATUS").equals("UNKNOWN")){
                // An uncertain outbound request blocks retransmission, not safe inbound order collection.
                try{if(Boolean.TRUE.equals(map.get("BASELINE_VERIFIED")))collectOrders(map,lease);}catch(RuntimeException ignored){/* Keep UNKNOWN until an explicit reconciliation. */}
                items.add(item(id,"UNKNOWN","이전 전송 결과가 불명확합니다. 자동 재전송하지 않습니다. 판매자센터 대사가 필요합니다."));continue;
            }
            if(!Boolean.TRUE.equals(map.get("BASELINE_VERIFIED"))){items.add(mark(id,"BLOCKED","초기 재고 기준과 기존 미출고 주문 포함 여부를 먼저 확인해 주세요."));continue;}
            boolean attemptedWrite=false;
            try{
                if(!collectOrders(map,lease)){items.add(mark(id,"PENDING","주문 수집이 아직 진행 중입니다. 재고는 전송하지 않았습니다."));continue;}
                map=mapping(id);renew(lease);var latest=client.detail(map.get("ORIGIN_PRODUCT_NO").toString());int remote=remoteStock(latest,option(map));
                if(remote!=number(map,"REMOTE_STOCK")){items.add(mark(id,"CONFLICT","네이버 재고가 예상 수량과 다릅니다. 미수집 주문·판매자센터 변경을 확인해 주세요."));continue;}
                if(!enabled){items.add(mark(id,"BLOCKED","주문 확인을 완료했습니다. 서버의 네이버 재고 전송 설정은 꺼져 있습니다."));continue;}
                var product=inventory.find(id,false);long version=number(product,"INVENTORY_VERSION");int quantity=((Number)product.get("STOCK")).intValue();
                if(quantity!=remote){
                    renew(lease);
                    s.tx.executeWithoutResult(tx->{var fresh=inventory.find(id,true);if(number(fresh,"INVENTORY_VERSION")!=version)throw InventoryService.error(409,"CONFLICT","전송 준비 중 재고가 변경되었습니다.");s.jdbc.update("UPDATE smartstore_mappings SET status='UNKNOWN',message=? WHERE card_id=?","네이버 전송 결과를 확인 중입니다. 중복 전송하지 않습니다.",id);});
                    attemptedWrite=true;client.writeStock(map.get("ORIGIN_PRODUCT_NO").toString(),option(map),quantity,latest);renew(lease);
                    if(remoteStock(client.detail(map.get("ORIGIN_PRODUCT_NO").toString()),option(map))!=quantity){items.add(mark(id,"UNKNOWN","네이버 반영 후 수량이 다릅니다. 주문 또는 반영 결과를 수동 확인해 주세요."));continue;}
                }
                var outcome=s.tx.execute(tx->{var fresh=inventory.find(id,true);if(number(fresh,"INVENTORY_VERSION")!=version)return mark(id,"CONFLICT","네이버 확인 중 공통 재고가 변경되었습니다. 다시 대사해 주세요.");s.jdbc.update("UPDATE smartstore_mappings SET remote_stock=?,status='SYNCED',last_synced=?,message=? WHERE card_id=?",quantity,s.now(),"네이버 재고 조회로 동일 수량을 확인했습니다.",id);return item(id,"SYNCED","네이버 재고 조회로 동일 수량을 확인했습니다.");});items.add(outcome);
            }catch(SmartStoreClient.Failure failure){items.add(mark(id,attemptedWrite?"UNKNOWN":failure.state,attemptedWrite?"네이버 전송 또는 반영 확인에 실패했습니다. 자동 재전송하지 않습니다. 판매자센터 대사가 필요합니다.":failure.getMessage()));}
            catch(InventoryException failure){items.add(mark(id,attemptedWrite?"UNKNOWN":"CONFLICT",attemptedWrite?"전송 중 공통 원장이 변경되었습니다. 자동 재전송하지 않습니다.":failure.getReason()));}
        }
        var result=new LinkedHashMap<String,Object>();result.put("items",items);result.put("lastSyncAt",status().get("lastSyncAt"));return result;
    });}
    public void scheduledSync(){
        if(!autoEnabled||!enabled||!client.configured())return;
        s.jdbc.update("UPDATE smartstore_mappings SET status='BLOCKED',message='연결을 등록한 관리자의 권한이 해제되었습니다.' WHERE actor_id NOT IN (SELECT id FROM shop_users WHERE role='ADMIN') AND status<>'UNKNOWN'");
        var rows=s.jdbc.queryForList("SELECT m.card_id,m.actor_id FROM smartstore_mappings m JOIN shop_users u ON u.id=m.actor_id WHERE m.baseline_verified=TRUE AND u.role='ADMIN' AND m.card_id>? ORDER BY m.card_id LIMIT 20",scheduledAfter);
        if(rows.isEmpty()){scheduledAfter="";rows=s.jdbc.queryForList("SELECT m.card_id,m.actor_id FROM smartstore_mappings m JOIN shop_users u ON u.id=m.actor_id WHERE m.baseline_verified=TRUE AND u.role='ADMIN' ORDER BY m.card_id LIMIT 20");}
        var groups=new LinkedHashMap<String,List<String>>();for(var row:rows){scheduledAfter=row.get("CARD_ID").toString();groups.computeIfAbsent(row.get("ACTOR_ID").toString(),key->new ArrayList<>()).add(scheduledAfter);}
        for(var group:groups.entrySet())sync(new InventoryDeviceService.Device("AUTOMATION",group.getKey()),group.getValue());
    }
}
