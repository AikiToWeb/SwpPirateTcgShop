package com.swp.shop;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/shop-api")
public class InventoryController {
    private final AdminController admin;
    private final InventoryDeviceService devices;
    private final InventoryService inventory;
    private final SmartStoreService smart;
    public InventoryController(AdminController admin,InventoryDeviceService devices,InventoryService inventory,SmartStoreService smart){this.admin=admin;this.devices=devices;this.inventory=inventory;this.smart=smart;}
    public record Name(@NotBlank @Size(max=80) String deviceName){}
    public record Pair(@NotBlank @Pattern(regexp="[A-Za-z0-9_-]{43}") String pairCode,@NotBlank @Size(max=80) String deviceName){}
    @PostMapping("/admin/inventory/pairings") public Object pairing(HttpServletRequest req,@Valid @RequestBody Name body){return devices.createPairing(admin.admin(req,true),body.deviceName());}
    @GetMapping("/admin/inventory/devices") public Object devices(HttpServletRequest req){return devices.devices(admin.admin(req,false));}
    @DeleteMapping("/admin/inventory/devices/{id}") public Object revoke(HttpServletRequest req,@PathVariable String id){return devices.revoke(admin.admin(req,true),id);}
    @PostMapping("/inventory/pair") public Object pair(HttpServletRequest req,@Valid @RequestBody Pair body){InventoryDeviceService.nativeRequest(req);return devices.pair(body.pairCode(),body.deviceName());}
    @DeleteMapping("/inventory/device") public Object disconnect(HttpServletRequest req){var device=devices.authenticate(req);return devices.revoke(device.actorId(),device.id());}
    @GetMapping("/inventory/products") public Object products(HttpServletRequest req,@RequestParam(defaultValue="") String query,@RequestParam(defaultValue="100") int limit,@RequestParam(defaultValue="0") int offset){devices.authenticate(req);return inventory.products(query,limit,offset);}
    @GetMapping("/inventory/overview") public Object overview(HttpServletRequest req){devices.authenticate(req);return inventory.overview();}
    @GetMapping("/inventory/history") public Object history(HttpServletRequest req,@RequestParam(required=false) String productId,@RequestParam(defaultValue="100") int limit,@RequestParam(defaultValue="0") int offset){devices.authenticate(req);return inventory.history(productId,limit,offset);}
    @PostMapping("/inventory/stock") public Object stock(HttpServletRequest req,@Valid @RequestBody InventoryService.Stock body){return inventory.adjust(devices.authenticate(req),body);}
    @GetMapping("/inventory/info") public Object info(HttpServletRequest req){devices.authenticate(req);var status=smart.status();return Map.of("name","SWP store","smartStoreConfigured",status.get("configured"),"smartStoreConnected",status.get("connected"),"smartStoreSyncEnabled",status.get("syncEnabled"),"message","기존 상점의 판매가능 재고를 사용합니다. 상품 등록은 상점 관리에서 진행하세요.");}
    @GetMapping("/inventory/smartstore/status") public Object smartStatus(HttpServletRequest req){devices.authenticate(req);return smart.probeStatus();}
    @GetMapping("/inventory/smartstore/products") public Object smartProducts(HttpServletRequest req,@RequestParam(defaultValue="") String query,@RequestParam(defaultValue="1") int page){devices.authenticate(req);return smart.products(query,page);}
    @GetMapping("/inventory/smartstore/mappings") public Object mappings(HttpServletRequest req){devices.authenticate(req);return smart.mappings();}
    @PutMapping("/inventory/smartstore/mappings") public Object mapping(HttpServletRequest req,@Valid @RequestBody SmartStoreService.Mapping body){return smart.map(devices.authenticate(req),body);}
    @PostMapping("/inventory/smartstore/mappings/{productId}/baseline") public Object baseline(HttpServletRequest req,@PathVariable String productId,@Valid @RequestBody SmartStoreService.Baseline body){return smart.baseline(devices.authenticate(req),productId,body);}
    @PostMapping("/inventory/smartstore/sync") public Object sync(HttpServletRequest req,@Valid @RequestBody SmartStoreService.Sync body){return smart.sync(devices.authenticate(req),body.productIds());}
    @ExceptionHandler(SmartStoreClient.Failure.class) public org.springframework.http.ResponseEntity<?> smartFailure(SmartStoreClient.Failure failure){return org.springframework.http.ResponseEntity.status(failure.state.equals("NOT_CONFIGURED")?503:502).body(Map.of("code",failure.state,"detail",failure.getMessage()));}
}
