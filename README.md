# SWP Pirate TCG Shop

SWP shop 카드 상점. Vanilla JavaScript/Vite 프론트와 FastAPI/SQLite API를 사용합니다.

## 로컬 실행

Python 3.11 이상, Node.js 22.12 이상을 사용합니다. 두 터미널에서 각각 실행합니다.

```powershell
cd backend
py -3 -m pip install -r requirements.txt
Copy-Item .env.shop.example .env.shop
# .env.shop에 본인 카카오 앱의 REST API 키와 Client Secret을 설정
py -3 run_shop.py
```

```powershell
cd frontend
npm.cmd ci
npm.cmd run dev
```

상점: http://127.0.0.1:5175/rolling.html

카카오 앱 로그인 Redirect URI: `http://127.0.0.1:5175/shop-api/auth/callback`. 카카오 로그인 사용을 활성화하고 REST API 키의 Client Secret을 설정합니다. 키는 서버 전용 `.env.shop`에 보관하며 Git에 올리지 않습니다.

## 기능

- 카카오 로그인, 서비스 로그아웃, HttpOnly 세션 및 CSRF 검증
- 상품 검색·정렬·상세, 계정별 바인더·장바구니 저장
- 비로그인 장바구니를 로그인 시 계정에 병합
- 매장 수령 주문 접수·취소, 서버 가격 계산과 재고 예약·복구
- 중복 주문 방지와 SQLite 트랜잭션을 통한 동시 주문 보호

카드 4장과 매장 일정은 개발용 예시입니다. 실결제·배송·실제 매장 재고·알림 발송은 연동하지 않습니다. 로컬 데이터는 `backend/data/swp.db`에 생성됩니다. 운영 배포는 HTTPS, 동일 출처 `/shop-api` 역방향 프록시, 해당 도메인의 카카오 Redirect URI 설정이 필요합니다.

## 빌드와 테스트

```powershell
cd frontend
npm.cmd run build
```

정적 산출물: `frontend/rolling-dist/`. API 서버는 별도로 실행해야 합니다.

```powershell
cd backend
py -3 -m pytest tests -q -p no:cacheprovider
```

## 이미지

SWP shop 배너는 제공된 원본 이미지를 바탕으로 제작했습니다. 카드 이미지는 참고 사이트가 사용하는 mtg-kr.com 이미지이며 원 저작권자에게 권리가 있습니다. 참고: [Rolling Dice](https://tcgrollingdice.com/index.php).

상세 구현·검증 내용은 [docs.md](docs.md)를 참조하세요.
