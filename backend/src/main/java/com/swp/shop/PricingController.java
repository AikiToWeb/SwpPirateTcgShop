package com.swp.shop;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/shop-api/admin/pricing")
public class PricingController {
    private final AdminController admin;private final PricingService service;
    public PricingController(AdminController admin,PricingService service){this.admin=admin;this.service=service;}
    @PostMapping("/quote") public PricingModels.Result quote(HttpServletRequest request,@Valid @RequestBody PricingModels.Request body){return service.quote(admin.admin(request,true),body);}
}
