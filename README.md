# BUFFER 버퍼 티켓 예매

공연 4회차(11.14 토 3PM·7PM, 11.15 일 3PM·7PM)의 자유석 예매 사이트입니다.
Node 22.5 이상에서 동작하며, Supabase 클라우드 데이터베이스(및 로컬 SQLite 폴백)를 지원합니다.

## 실행 및 개발

```bash
npm install              # 의존성 설치 (@supabase/supabase-js, vite)

# 1. 통합 개발 서버 실행 (Node 백엔드 + Vite HMR 실시간 새로고침)
npm run dev              # http://localhost:3000 접속 (코드 수정 시 브라우저 즉시 반영)

# 2. Vite 단독 개발 서버 (필요 시)
npm run dev:vite         # http://localhost:5173 접속 (/api는 3000번 포트로 프록시)

# 3. Vite 프로덕션 빌드
npm run build            # dist/ 디렉터리에 번들링 및 최적화

# 4. 프로덕션 실행
npm start
```

환경변수는 `.env` 파일에서 자동으로 불러옵니다:

```bash
cp .env.example .env     # 설정값 수정 (ADMIN_TOKEN, SUPABASE_URL, SUPABASE_KEY 등)
npm run dev
```

- 예매 페이지: `/`
- 관리자 페이지: `/admin` (`ADMIN_TOKEN` 입력, 예매 목록 실시간 검색/필터, CSV 내려받기, 삭제)
- Supabase SQL 마이그레이션: `supabase-schema.sql` (Supabase Dashboard의 SQL Editor에서 복사하여 [Run] 실행)

## Supabase 설정 방법

1. [Supabase Dashboard](https://supabase.com/dashboard) 프로젝트 열기
2. 좌측 메뉴 **SQL Editor**로 이동
3. 프로젝트의 `supabase-schema.sql` 내용 전체를 복사하여 붙여넣고 **[Run]** 클릭
4. `.env` 파일에 `SUPABASE_URL`과 `SUPABASE_KEY`가 올바르게 입력되었는지 확인 후 서버 재실행

## 기획서 반영 사항

| 항목 | 구현 |
| --- | --- |
| 오픈 | 11/4(수) 20:00 (KST). 서버 시각 기준으로 열리며, 그 전 예매 요청은 서버가 거부합니다 |
| 회차 | 4회차. 회차별 예매 좌석 수는 `SEATS`로 따로 정함 (기본 35석). **화면에는 좌석 수·잔여석을 표시하지 않고**, 매진되면 그 회차의 예매 버튼만 눌리지 않음 |
| 좌석 | 자유석, 예매번호는 `BUF-회차-번호` (예: `BUF-B-07`). 좌석 방식은 화면에 노출하지 않음 |
| 매수 | 1인 1매. **전화번호당 1건**으로 판정 (취소하면 다시 예매 가능). 매수 규칙은 화면에 노출하지 않음 |
| 예매 흐름 | 예매하기 → **아카이빙·트리거 워닝 팝업** 확인 → 이름·전화번호 입력 → 예매 완료(예매번호). 결제 단계 없음 |
| 동시 접속 | Supabase RPC 원자적 트랜잭션 락(`pg_advisory_xact_lock`)으로 동시 요청 시 좌석 중복 및 정원 초과 원천 방지 |

## 설정 (환경변수)

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | 3000 | 서버 포트 |
| `OPEN_AT` | 2026-11-04T20:00:00+09:00 | 예매 오픈 시각 |
| `ADMIN_TOKEN` | (없음) | 비우면 관리자 기능이 꺼집니다 |
| `SUPABASE_URL` | https://qatrsegoqwandtsasunp.supabase.co | Supabase 프로젝트 URL |
| `SUPABASE_KEY` | sb_publishable_... | Supabase Publishable / Anon / Service Key |
| `DB_PATH` | ./data/tickets.db | SQLite 로컬 DB 위치 (Supabase 미연동 시 폴백) |
| `SEATS` | `A=26,B=26,C=32,D=32` | 회차별 예매 좌석 수 (1·2회차 26매, 3·4회차 32매) |
| `BOOK_RATE_MAX` | 30 | IP당 10분간 예매 시도 한도 |
| `TICKET_PRICE` | 0 | 결제 화면에 표시되는 금액(원). 0이면 "무료" |
| `TRUST_PROXY` | 0 | 프록시 뒤에서 실행하면 1 (`X-Forwarded-For` 사용) |

오픈 전에 흐름을 점검하려면 `OPEN_AT=2020-01-01T00:00:00Z`로 띄우고, 점검 뒤 `data/`를 지우세요.

## 배포

한 대의 서버(또는 Railway, Fly.io, Render 같은 Node 호스팅)에서 프로세스 하나로 돌리는 구성입니다.
SQLite 파일을 쓰므로 **인스턴스를 여러 대로 늘리지 말고**, 디스크가 유지되는 볼륨에 `DB_PATH`를 두세요.
HTTPS는 호스팅 플랫폼이나 앞단 프록시에서 처리합니다.

## 알아둘 것

- 수집하는 개인정보는 이름·전화번호이고 관리자만 볼 수 있습니다. 공연이 끝나면 `data/`를 삭제하세요.
- 화면 디자인은 키컬러 모노톤, 템포를 형상화한 9개의 선과 구역 분할로 만들었습니다. 로고(라이트/다크 자동 전환), 프로필 10장, INFO 모션 영상을 반영했습니다. 포스터는 사이트에 넣지 않았습니다.
- 이미지는 `assets/`의 원본을 가공 없이 `/assets/` 경로로 그대로 서빙합니다(로고·프로필·영상). 프로필 JPG가 장당 4~26MB라 첫 로딩이 무겁습니다. 배포 전에 웹용으로 줄이는 것을 권장합니다.
- 화면 전체에 검은 정사각형들이 떨어지는 애니메이션이 깔려 있습니다(`public/app.js`의 falling boxes, `#fall`). 스크롤을 내리면 서서히 사라지고(한 화면 아래에서 완전히), 다시 올리면 돌아옵니다. 동작 줄이기 설정을 켠 기기에서는 멈춰 있습니다.
- 티저 영상은 용량(222MB) 때문에 저장소에 없어서 "COMING SOON" 자리표시만 있습니다(`public/index.html`의 `#teaser`). `assets/design/MOTION/BUFFER INFO.mp4`는 화면에 쓰지 않았습니다.
- 방명록, 파동 프리뷰(WAITING ROOM) 페이지는 포함되어 있지 않습니다.
