# PostgreSQL / Neon

Java 서버는 H2와 PostgreSQL을 지원합니다. DB 접속 정보는 서버의 `.env.shop` 또는 환경 변수에만 둡니다. 브라우저에는 DB 접속 정보를 전달하지 않습니다.

```dotenv
SHOP_DATABASE_URL=jdbc:postgresql://YOUR_HOST/neondb?sslmode=verify-full&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory
SHOP_DATABASE_USERNAME=neondb_owner
SHOP_DATABASE_PASSWORD=YOUR_PASSWORD
```

Neon 콘솔의 SWP shop 프로젝트에서 Connect로 접속 정보를 확인합니다. 무료 플랜·싱가포르 리전을 사용하며 Java 연결 풀은 최대 5개, 최소 유휴 연결 0개입니다. 유휴 연결을 줄여도 실제 쿼리가 계속 발생하면 Neon 컴퓨트는 계속 사용됩니다. 무료 한도는 Neon 콘솔에서 확인합니다.

## H2 데이터 보존 이전

1. 서버를 정상 종료하고 `data/swp.mv.db`를 별도 이름으로 백업합니다.
2. 대상 PostgreSQL 접속 정보를 Git 제외 파일 `.env.neon`에 저장합니다.
3. Java 21 및 H2·PostgreSQL JDBC JAR를 준비합니다. `mvn package`로 해당 드라이버가 내려옵니다.
4. backend 디렉터리에서 다음 명령을 실행합니다. 경로 구분자는 macOS/Linux에서 `:`, Windows에서 `;`입니다.

```sh
java --class-path '/path/to/h2.jar:/path/to/postgresql.jar' tools/MigrateH2ToPostgres.java data/swp .env.neon
```

도구는 원본 H2를 읽기 전용으로 열고, 대상 스키마를 생성한 뒤 12개 테이블이 모두 비어 있는지 확인합니다. 데이터 복사는 단일 트랜잭션으로 수행하고 건수를 검증합니다. 대상에 데이터가 있으면 중단하며, 실패한 데이터 복사는 롤백합니다. 스키마 생성은 별도 단계이므로 실패 후 빈 테이블은 남을 수 있습니다. 원본 파일은 수정하지 않습니다. 자동 증가 ID의 다음 값도 조정합니다.

이전 완료 후 `.env.shop`의 DB 접속 설정만 PostgreSQL로 변경하고 서버를 시작합니다. 회원·세션 등도 이전되므로 해당 정보를 외부 서비스로 옮길 권한이 있는 경우에만 실행합니다. H2로 되돌릴 때는 기존 파일을 가리키도록 설정을 복구합니다. PostgreSQL에서 새로 발생한 주문·회원 변경은 H2에 자동 복제되지 않습니다.

## 검증

기본 `mvn test`는 별도 메모리 H2에서 실행합니다. 실제 PostgreSQL 테스트는 운영과 다른 빈 DB를 준비한 뒤 실행합니다. 테스트는 데이터를 삭제·생성하므로 운영 URL을 절대 사용하지 않습니다.

```sh
TEST_DATABASE_URL=jdbc:postgresql://127.0.0.1:55432/swp_test \
SHOP_DATABASE_USERNAME=swp_test \
SHOP_DATABASE_PASSWORD='' mvn test
```

## DBeaver

PostgreSQL 드라이버를 선택하고 Neon Connect 화면의 직접 연결 호스트, 포트 5432, DB명, 사용자명·비밀번호를 사용합니다. SSL을 활성화합니다. JDBC URL을 사용한다면 위 URL과 같은 TLS 검증 옵션을 적용할 수 있습니다. Java 서버와 동시에 접속 가능합니다.

## Render 배포

Render 서버 환경 변수에 같은 DB 연결 설정과 기존 카카오 설정을 등록합니다. `SHOP_BIND_ADDRESS=0.0.0.0`을 지정하고 Render의 `PORT`를 사용합니다. 배포 주소가 정해지면 `SHOP_ORIGIN`과 기존 카카오 앱 Redirect URI를 함께 설정해야 합니다. 로컬 PC에는 Java 서버나 DB를 계속 켜둘 필요가 없습니다. 이 문서의 Neon 설정만으로 Render 배포까지 완료되지는 않습니다.
