package com.swp.shop;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ShopApplication {
    public static void main(String[] args) throws Exception {
        // Existing server-only Kakao settings remain local and Git-ignored.
        Path file = Path.of(".env.shop");
        Set<String> allowed = Set.of("SHOP_ORIGIN", "KAKAO_REST_API_KEY", "KAKAO_CLIENT_SECRET", "SHOP_DATABASE_URL", "SHOP_DATABASE_PASSWORD", "SHOP_DATABASE_USERNAME", "SHOP_BIND_ADDRESS", "SHOP_ADMIN_KAKAO_ID");
        if (Files.exists(file)) for (String line : Files.readAllLines(file)) {
            int split = line.indexOf('=');
            if (split < 1 || line.stripLeading().startsWith("#")) continue;
            String key = line.substring(0,split).trim().replace("\uFEFF", "");
            if (allowed.contains(key) && System.getenv(key) == null && System.getProperty(key) == null)
                System.setProperty(key, line.substring(split+1).trim());
        }
        SpringApplication.run(ShopApplication.class,args);
    }
}
