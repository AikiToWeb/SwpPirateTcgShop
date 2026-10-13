# SWP Pirate TCG Shop

Java 21 / Spring Boot 3.5 + React / Vite + H2 파일 DB 기반 카드 상점입니다.

## 실행

Java 21+, Maven 3.9+, Node.js 22.12+가 필요합니다. 두 터미널에서 실행합니다.

```powershell
cd backend
Copy-Item .env.shop.example .env.shop
# .env.shop의 카카오 REST API 키와 Client Secret을 입력 (기존 파일이 있으면 복사하지 않음)
./run-java.ps1 -Build
```

```powershell
cd frontend
npm.cmd ci
npm.cmd run dev
```

상점: http://127.0.0.1:5175/rolling.html
API: http://127.0.0.1:8001/shop-api/health

`run-java.ps1`은 JAVA_HOME 또는 사용자 .jdks의 Java 21을 선택합니다. 전역 Java 설정을 변경하지 않습니다. macOS/Linux에서는 JAVA_HOME을 Java 21로 설정하고 backend에서 `mvn package`, `java -jar target/swp-shop-0.2.0.jar`를 실행합니다.

## DB

최초 Java 서버 실행 시 `schema.sql`로 테이블을 생성하며 데이터는 `backend/data/swp.mv.db`에 보존합니다. 사용자·세션·상품·바인더·장바구니·주문·주문항목·이벤트 테이블을 사용합니다. 브라우저의 상품 가격·재고·컨디션·게임 분류·일정·주문 상태는 API를 통해 이 DB에서 읽습니다.

신규 DB에는 참고 카드 4장과 예시 일정 2건을 등록합니다. 실제 매장이나 네이버 상품 API는 아직 연동하지 않았습니다. 현재 로컬 DB는 이전 SQLite에 저장된 상품·회원·세션·주문·바인더·장바구니를 가져온 상태입니다. 이전 SQLite 파일은 삭제하지 않았습니다. 데이터 및 키 파일은 Git에서 제외합니다.

`data/legacy-import.json`이 존재하면 비어 있는 H2 DB에 한 번만 이전하며, migration_history에 기록합니다. 이미 데이터가 있는 DB를 덮어쓰지 않습니다. H2 콘솔은 공개하지 않습니다.

## 기능

- 실제 카카오 로그인, 서비스 로그아웃, HttpOnly 세션과 CSRF 검증
- React 상품 검색·정렬·상세 및 품절 상태, 서버 정보 새로고침
- 계정별 바인더·장바구니 저장, 로그인 시 비회원 장바구니 병합
- 매장 수령 주문·취소, DB 가격 계산 및 재고 차감·복구
- 중복 주문 방지, 행 잠금과 트랜잭션을 통한 동시 주문 재고 보호
- DB에 저장된 매장 이벤트 표시

주문은 개발용 매장 수령 접수입니다. 온라인 결제·배송·실제 매장 재고·알림 발송은 연동하지 않습니다.

## 카카오

`backend/.env.shop`에 `SHOP_ORIGIN`, `KAKAO_REST_API_KEY`, `KAKAO_CLIENT_SECRET`을 설정합니다. 로그인 Redirect URI는 `http://127.0.0.1:5175/shop-api/auth/callback`이며 기존 SWP shop 앱의 설정을 그대로 사용합니다. 카카오 토큰은 프론트 또는 DB에 저장하지 않습니다. HTTPS 환경은 Secure 쿠키를 적용합니다.

## 빌드·검증

```powershell
cd backend
mvn.cmd test package
```

Java 통합 테스트: 인증·CSRF, 계정 분리, 잘못된 장바구니, 서버 금액 계산, 주문 멱등성, 소유권, 취소 복구, 트랜잭션 롤백, 동시 주문 재고 보호, 로그아웃을 확인합니다. 테스트는 실제 DB와 분리된 메모리 H2를 사용합니다.

```powershell
cd frontend
npm.cmd run build
npm.cmd run preview
```

개발은 Vite, 배포 빌드는 esbuild로 같은 React 소스를 번들링합니다. 산출물은 frontend/dist이며 Java API를 별도로 실행해야 합니다. Windows에서 Vite/Rollup 빌드가 중간에 종료되는 현상을 피해 esbuild의 명시적 production 빌드를 사용합니다.

운영 배포 시 HTTPS와 동일 출처 `/shop-api` 역방향 프록시를 구성하고, 배포 도메인으로 카카오 Redirect URI와 SHOP_ORIGIN을 변경해야 합니다.

## 이미지

SWP shop 배너는 제공된 원본 이미지로 제작했습니다. 카드 이미지는 참고 사이트가 사용하는 mtg-kr.com 이미지이며 각 원 저작권자에게 권리가 있습니다. 참고: https://tcgrollingdice.com/index.php
