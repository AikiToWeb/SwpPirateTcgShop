import java.nio.file.*;
import java.sql.*;
import java.util.*;

/** Offline copy into an empty PostgreSQL database. Never modifies the H2 source. */
public class MigrateH2ToPostgres {
    static final List<String> TABLES=List.of("games","cards","shop_users","sessions","oauth_states","binders","carts","shop_orders","order_items","stock_movements","shop_events","migration_history");
    static Map<String,String> config(Path path) throws Exception {
        var result=new HashMap<String,String>();
        for(String line:Files.readAllLines(path)){int n=line.indexOf('=');if(n>0&&!line.stripLeading().startsWith("#"))result.put(line.substring(0,n).trim(),line.substring(n+1).trim());}
        return result;
    }
    public static void main(String[] args) throws Exception {
        if(args.length!=2)throw new IllegalArgumentException("Usage: MigrateH2ToPostgres <H2 database path without extension> <target env file>");
        var env=config(Path.of(args[1]));
        String target=env.get("SHOP_DATABASE_URL");
        if(target==null||!target.startsWith("jdbc:postgresql:"))throw new IllegalArgumentException("PostgreSQL target required");
        try(var source=DriverManager.getConnection("jdbc:h2:file:"+Path.of(args[0]).toAbsolutePath()+";ACCESS_MODE_DATA=r;IFEXISTS=TRUE","sa","");
            var dest=DriverManager.getConnection(target,env.get("SHOP_DATABASE_USERNAME"),env.get("SHOP_DATABASE_PASSWORD"))){
            source.setReadOnly(true);
            try(var statement=dest.createStatement()){
                for(String sql:Files.readString(Path.of("src/main/resources/schema.sql")).split(";"))if(!sql.isBlank())statement.execute(sql);
            }
            dest.setAutoCommit(false);
            try {
                for(String table:TABLES)try(var q=dest.createStatement();var rows=q.executeQuery("SELECT COUNT(*) FROM "+table)){rows.next();if(rows.getLong(1)!=0)throw new IllegalStateException("Target must be empty: "+table);}
                for(String table:TABLES){
                    long count=0;
                    try(var select=source.createStatement();var rows=select.executeQuery("SELECT * FROM "+table)){
                        var meta=rows.getMetaData();int n=meta.getColumnCount();var columns=new ArrayList<String>();
                        for(int i=1;i<=n;i++)columns.add(meta.getColumnName(i).toLowerCase(Locale.ROOT));
                        String sql="INSERT INTO "+table+"("+String.join(",",columns)+") VALUES("+String.join(",",Collections.nCopies(n,"?"))+")";
                        try(var insert=dest.prepareStatement(sql)){while(rows.next()){for(int i=1;i<=n;i++)insert.setObject(i,rows.getObject(i));insert.executeUpdate();count++;}}
                    }
                    try(var q=dest.createStatement();var rows=q.executeQuery("SELECT COUNT(*) FROM "+table)){rows.next();if(rows.getLong(1)!=count)throw new IllegalStateException("Count mismatch: "+table);}
                    System.out.println(table+": "+count);
                }
                for(String table:List.of("shop_events","stock_movements"))try(var q=dest.createStatement()){q.execute("SELECT setval(pg_get_serial_sequence('"+table+"','id'),COALESCE(MAX(id),1),MAX(id) IS NOT NULL) FROM "+table);}
                dest.commit();System.out.println("Migration committed; H2 source preserved.");
            }catch(Exception failure){dest.rollback();throw new IllegalStateException("Migration rolled back; target data was not overwritten.");}
        }catch(SQLException failure){throw new IllegalStateException("Database connection or schema initialization failed; check local configuration without printing credentials.");}
    }
}
