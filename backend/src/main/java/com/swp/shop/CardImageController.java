package com.swp.shop;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/shop-api/admin/images")
public class CardImageController {
    private final AdminController admin;
    private final CardImageService images;
    public record Search(@NotBlank @Size(max=80) String game,@NotBlank @Size(max=120) String query,@NotBlank @Size(max=30) String language,@Min(0) @Max(20) Integer page){
        public Search{game=game==null?null:game.trim();query=query==null?null:query.trim();language=language==null?null:language.trim();page=page==null?0:page;}
    }
    public CardImageController(AdminController admin,CardImageService images){this.admin=admin;this.images=images;}
    @PostMapping("/search") public Object search(HttpServletRequest request,@Valid @RequestBody Search body){admin.admin(request,true);return images.search(body);}
}
