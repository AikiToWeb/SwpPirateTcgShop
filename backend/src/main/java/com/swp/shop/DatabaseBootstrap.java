package com.swp.shop;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

@Component
public class DatabaseBootstrap implements ApplicationRunner {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final ObjectMapper json;
    @Value("${SHOP_IMPORT_ENABLED:true}") private boolean importEnabled;
    @Value("${SHOP_ADMIN_KAKAO_ID:}") private String adminId;
    public DatabaseBootstrap(JdbcTemplate jdbc,TransactionTemplate tx,ObjectMapper json){this.jdbc=jdbc;this.tx=tx;this.json=json;}

    public void run(ApplicationArguments args) throws Exception {
        Path source=Path.of("data/legacy-import.json");
        if (importEnabled && Files.exists(source) && jdbc.queryForObject("SELECT COUNT(*) FROM migration_history WHERE name='sqlite-v1'",Integer.class)==0) {
            var data=json.readValue(source.toFile(),new TypeReference<Map<String,List<Map<String,Object>>>>(){});
            tx.executeWithoutResult(status->{
                if(jdbc.queryForObject("SELECT COUNT(*) FROM cards",Integer.class)>0)
                    throw new IllegalStateException("Import requires an empty database; existing data is preserved.");
                for(var r:data.getOrDefault("cards",List.of())) jdbc.update("INSERT INTO cards(id,name,en,set_name,price,stock,image) VALUES(?,?,?,?,?,?,?)",r.get("id"),r.get("name"),r.get("en"),r.get("set"),r.get("price"),r.get("stock"),r.get("image"));
                for(var r:data.getOrDefault("users",List.of())) jdbc.update("INSERT INTO shop_users(id,nickname) VALUES(?,?)",r.get("id"),r.get("nickname"));
                for(var r:data.getOrDefault("sessions",List.of())) jdbc.update("INSERT INTO sessions VALUES(?,?,?,?)",r.get("token"),r.get("user_id"),r.get("csrf"),r.get("expires"));
                for(var r:data.getOrDefault("binders",List.of())) jdbc.update("INSERT INTO binders VALUES(?,?)",r.get("user_id"),r.get("card_id"));
                for(var r:data.getOrDefault("carts",List.of())) jdbc.update("INSERT INTO carts VALUES(?,?,?)",r.get("user_id"),r.get("card_id"),r.get("quantity"));
                for(var r:data.getOrDefault("orders",List.of())) jdbc.update("INSERT INTO shop_orders(id,user_id,request_key,status,total,created) VALUES(?,?,?,?,?,?)",r.get("id"),r.get("user_id"),r.get("request_key"),r.get("status"),r.get("total"),r.get("created"));
                for(var r:data.getOrDefault("order_items",List.of())) jdbc.update("INSERT INTO order_items VALUES(?,?,?,?,?)",r.get("order_id"),r.get("card_id"),r.get("name"),r.get("price"),r.get("quantity"));
                jdbc.update("INSERT INTO migration_history VALUES('sqlite-v1',?)",Instant.now().getEpochSecond());
            });
        }
        tx.executeWithoutResult(status->{
            String[] games={"매직 더 개더링","리프트바운드","플레시 앤 블러드","로카나"};
            for(int i=0;i<games.length;i++)jdbc.update("INSERT INTO games(name,sort_order) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM games WHERE name=?)",games[i],i,games[i]);
            if(jdbc.queryForObject("SELECT COUNT(*) FROM migration_history WHERE name='operational-v2'",Integer.class)==0){
                jdbc.update("UPDATE cards SET is_sample=TRUE,active=FALSE WHERE created=0 AND id IN ('M13-224','ISD-239','M12-219','M13-212')");
                jdbc.update("UPDATE shop_orders SET is_sample=TRUE WHERE id IN (SELECT oi.order_id FROM order_items oi JOIN cards c ON c.id=oi.card_id WHERE c.is_sample=TRUE)");
                jdbc.update("INSERT INTO migration_history VALUES('operational-v2',?)",Instant.now().getEpochSecond());
            }
            if(!adminId.isBlank())jdbc.update("UPDATE shop_users SET role='ADMIN' WHERE id=?",adminId);
        });
    }
}
