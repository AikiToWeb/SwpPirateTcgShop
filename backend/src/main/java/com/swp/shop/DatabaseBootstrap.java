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
    public DatabaseBootstrap(JdbcTemplate jdbc,TransactionTemplate tx,ObjectMapper json){this.jdbc=jdbc;this.tx=tx;this.json=json;}

    public void run(ApplicationArguments args) throws Exception {
        Path source=Path.of("data/legacy-import.json");
        if (importEnabled && Files.exists(source) && jdbc.queryForObject("SELECT COUNT(*) FROM migration_history WHERE name='sqlite-v1'",Integer.class)==0) {
            var data=json.readValue(source.toFile(),new TypeReference<Map<String,List<Map<String,Object>>>>(){});
            tx.executeWithoutResult(status->{
                if(jdbc.queryForObject("SELECT COUNT(*) FROM cards",Integer.class)>0)
                    throw new IllegalStateException("Import requires an empty database; existing data is preserved.");
                for(var r:data.getOrDefault("cards",List.of())) jdbc.update("INSERT INTO cards(id,name,en,set_name,price,stock,image) VALUES(?,?,?,?,?,?,?)",r.get("id"),r.get("name"),r.get("en"),r.get("set"),r.get("price"),r.get("stock"),r.get("image"));
                for(var r:data.getOrDefault("users",List.of())) jdbc.update("INSERT INTO shop_users VALUES(?,?)",r.get("id"),r.get("nickname"));
                for(var r:data.getOrDefault("sessions",List.of())) jdbc.update("INSERT INTO sessions VALUES(?,?,?,?)",r.get("token"),r.get("user_id"),r.get("csrf"),r.get("expires"));
                for(var r:data.getOrDefault("binders",List.of())) jdbc.update("INSERT INTO binders VALUES(?,?)",r.get("user_id"),r.get("card_id"));
                for(var r:data.getOrDefault("carts",List.of())) jdbc.update("INSERT INTO carts VALUES(?,?,?)",r.get("user_id"),r.get("card_id"),r.get("quantity"));
                for(var r:data.getOrDefault("orders",List.of())) jdbc.update("INSERT INTO shop_orders VALUES(?,?,?,?,?,?)",r.get("id"),r.get("user_id"),r.get("request_key"),r.get("status"),r.get("total"),r.get("created"));
                for(var r:data.getOrDefault("order_items",List.of())) jdbc.update("INSERT INTO order_items VALUES(?,?,?,?,?)",r.get("order_id"),r.get("card_id"),r.get("name"),r.get("price"),r.get("quantity"));
                jdbc.update("INSERT INTO migration_history VALUES('sqlite-v1',?)",Instant.now().getEpochSecond());
            });
        }
        tx.executeWithoutResult(status->{
            if(jdbc.queryForObject("SELECT COUNT(*) FROM cards",Integer.class)==0) {
                Object[][] cards={
                    {"M13-224","진화하는 야생지","Evolving Wilds","Magic 2013",500,3,"evolving-wilds.png"},
                    {"ISD-239","가보니 거주구","Gavony Township","Innistrad",8400,8,"gavony-township.png"},
                    {"M12-219","축지장화","Swiftfoot Boots","Magic 2012",6000,3,"swiftfoot-boots.png"},
                    {"M13-212","칼로니아의 반지","Ring of Kalonia","Magic 2013",900,8,"ring-of-kalonia.png"}};
                for(Object[] r:cards)jdbc.update("INSERT INTO cards(id,name,en,set_name,price,stock,image) VALUES(?,?,?,?,?,?,?)",r);
            }
            if(jdbc.queryForObject("SELECT COUNT(*) FROM shop_events",Integer.class)==0) {
                jdbc.update("INSERT INTO shop_events(game,title,starts_at,description) VALUES(?,?,?,?)","섀도우버스 이볼브","먼슬리 토너먼트","2026-10-13 19:30:00","참고 사이트 일정. 참가 가능 여부는 매장에 문의하세요.");
                jdbc.update("INSERT INTO shop_events(game,title,starts_at,description) VALUES(?,?,?,?)","리프트바운드","초보자 설명회","2026-10-13 19:30:00","참고 사이트 일정. 참가 가능 여부는 매장에 문의하세요.");
            }
        });
    }
}
