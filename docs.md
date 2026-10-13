# SWP shop

## 실행

두 터미널에서 각각 실행합니다.

```powershell
cd backend
py -3 run_shop.py
```

```powershell
cd frontend
npm.cmd run dev -- --port 5175
```

주소: http://127.0.0.1:5175/rolling.html

## 기능

상품·가격·재고는 독립 SQLite 상점 DB(`backend/data/swp.db`)에서 읽습니다. 최초 시작에 참조 카드 4장을 샘플로 넣으며 재시작해도 주문 및 변경된 재고를 보존합니다. 기존 운영 대시보드 DB 및 인증 없는 운영 API와 분리됩니다.

카카오 회원 로그인, 서비스 로그아웃, 계정별 바인더·장바구니 저장, 주문 목록·매장 수령 접수·취소를 제공합니다. 비로그인 장바구니는 브라우저에 저장하고 로그인 직후 계정 장바구니에 합칩니다. 카카오 로그인은 REST API 인가 코드 방식이며 서버가 토큰을 교환하고 사용자 ID를 확인합니다. 카카오 토큰은 브라우저나 DB에 저장하지 않습니다. 세션 쿠키는 HttpOnly, SameSite=Lax이며 HTTPS 사용 시 Secure도 적용합니다. 변경 요청은 Origin 및 세션 CSRF 토큰을 검사합니다.

주문 금액은 서버의 현재 가격으로 계산합니다. 재고 확인·예약·주문 기록을 하나의 트랜잭션으로 처리하고 주문 요청 키로 중복 접수를 방지합니다. 접수 상태 주문만 취소할 수 있으며 취소 재시도에도 재고를 한 번만 복구합니다. 실결제, 배송, 실제 매장 재고, 알림 발송은 연동하지 않습니다. 상품과 일정은 개발용 샘플입니다. 다른 게임은 등록 상품이 없습니다.

## 카카오 설정

`backend/.env.shop.example`을 참고해 `backend/.env.shop`에 `KAKAO_REST_API_KEY`와 `KAKAO_CLIENT_SECRET`을 저장합니다. 이 파일은 Git에서 제외됩니다. 변경 후 상점 API를 재시작합니다.

- 앱: SWP shop, ID 1606487, 쇼핑 카테고리 (신규 생성 및 로그인 활성화 완료)
- 로그인 Redirect URI: `http://127.0.0.1:5175/shop-api/auth/callback`
- 서비스 Origin: `http://127.0.0.1:5175`
- 카카오 로그인 활성화 및 REST API Client Secret 사용
- 사용자 ID만으로 로그인할 수 있으며 닉네임 제공 시 표시합니다. 이메일·연락처·주소 동의는 요청하지 않습니다.

주소나 포트 변경 시 SHOP_ORIGIN, Redirect URI, 프론트 프록시를 함께 바꿔야 합니다. 배포 시 HTTPS 및 동일 출처의 `/shop-api` 역방향 프록시가 필요합니다. `build:rolling`은 프론트 파일만 생성하며 API 서버를 포함하지 않습니다.

## 검증

`py -3 -m pytest tests/test_shop.py -q -p no:cacheprovider`: 인증·CSRF, 계정 분리, 주문 금액 검증, 중복 방지, 동시 주문 재고 보호, 취소 복구, OAuth 상태 검증과 세션 회전, 로그아웃을 검증합니다.

공식 카카오 REST API: https://developers.kakao.com/docs/ko/kakaologin/rest-api

2026-10-13 브라우저 검증: 실제 카카오 로그인·로그아웃·재로그인, 비로그인 장바구니의 계정 병합, 계정 장바구니·바인더의 새로고침 유지, 500원 샘플 주문 접수 및 재고 3→2 차감, 취소 후 2→3 복구를 확인했습니다. 해당 테스트 주문은 취소 상태로 남습니다. 전체 백엔드 테스트 14개 및 정적 프론트 빌드가 통과했습니다.
