# 서비스 확장 검토 — 무상태(stateless) 설계의 동시성 안전성 점검

앱은 "서버에 실험별 상태를 보관하지 않고, 브라우저가 요청마다 실험 설정을 전달"하며
"서버는 요청 간 사용자 상태를 공유하지 않는다"고 명시한다. 다수 사용자가 동시에
`/api/simulate`, `/api/export`를 호출하는 상황에서 이 주장이 실제로 성립하는지
`main.py`, `engine.py` 전체를 읽고 검증했다.

## 1. Isolation Forest는 요청마다 재학습되는가?

**아니오. 프로세스당 1회만 학습된다.**

- `engine.py:46-57`의 `detector()`는 `@lru_cache(maxsize=1)`로 감싸여 있어, 6,000개
  합성 샘플로 `IsolationForest.fit()`을 수행하고 4,000개 샘플로 위험도 앵커
  (quantile)를 보정하는 비용이 프로세스 생애주기 동안 정확히 한 번만 발생한다.
- `main.py:84-87`의 `lifespan()`이 앱이 요청을 받기 **전에** `detector()`를 동기
  호출해 캐시를 미리 채운다(warm-up). FastAPI/Starlette는 lifespan의 startup이
  끝나야 요청을 받기 시작하므로, 최초 요청과 캐시 채움 사이의 경쟁 조건도 없다.
- `engine.py:61`의 `infer()`는 매 요청마다 `detector()`를 호출하지만 `lru_cache`가
  즉시 캐시된 동일 객체(`model, anchors, mean, sd` 튜플)를 반환한다.
- **근거**: `tests/test_lab.py::test_isolation_forest_is_trained_once_not_per_request`
  추가 — 위성 수·경과시간이 다른 4개의 `/api/simulate` 호출 전후로
  `detector.cache_info().misses`가 증가하지 않고, 반환된 모델 객체가 `is`로 동일함을
  확인한다.

## 2. 동시 요청 간 경쟁(race)을 일으킬 공유 가변 상태가 있는가?

**없음.** `FIELDS`, `LABELS`, `UNITS`, `STATIONS`, `FAULTS`, `ACTIONS`는 모두
모듈 로드시 정의되는 읽기 전용 상수이며, 요청 처리 경로(`geometry`, `telemetry`,
`diagnose`, `snapshot`, 두 API 핸들러) 전체를 확인한 결과 이들 전역을 변형(`append`,
`update`, 재할당 등)하는 코드는 없다(`grep`으로 전수 확인). 요청별 배열(`v`,
`capacity`, `sats`, `alerts` 등)은 모두 함수 지역 변수다. 캐시된 `IsolationForest`
객체에 대한 `score_samples()` 호출도 추론 전용 연산으로, 내부 상태를 쓰지 않으므로
스레드 간 안전하다(동기 엔드포인트는 Starlette 스레드풀에서 병렬 실행됨).
`main.py:94-114`의 바디 크기 제한 미들웨어도 요청마다 새 `bytearray`를 사용해
`request`별로 격리된다.

- **근거**: `tests/test_lab.py::test_concurrent_max_size_requests_are_race_free_and_deterministic`
  추가 — `ThreadPoolExecutor`로 512기(32×16) 궤도군, 24시간 경과 설정의
  `/api/simulate`를 12개 워커로 24회 동시 호출하고, 같은 seed의 응답이 동시 실행
  중에도 완전히 동일함(교차 오염 없음)을 검증한다.

## 3. 512기/24시간 상한에서 비정상적으로 커지는 요청당 비용이 있는가?

**없음.** 전체 위성(n≤512) 연산은 `geometry`/`telemetry`에서 NumPy로 벡터화되어
있고, 장애(`faults`)·대응(`actions`) 개수는 각각 62바이트 요청 크기 제한과 별개로
`max_length=64`로 이미 제한되어 있다(`main.py:59-60`). `snapshot()`의 이력(history)
루프는 경과시간과 무관하게 고정 폭(최근 1200초를 30초 간격, 약 41개 시점)만
계산하고, 지상궤적(`track`)도 고정 97개 점만 계산하며 둘 다 선택된 위성 1기에
대해서만 수행되므로 위성 수 증가와 무관하다. 요청 바디는 64KB로 사전 제한된다.
경과시간·위성 수·장애/대응 개수 조합을 늘려도 선형 이상으로 증가하는 지점을
찾지 못했다.

## 변경 사항

코드 로직(`main.py`, `engine.py`) 자체에는 실제 확장성 결함을 발견하지 못해
수정하지 않았다. 위 3가지 보장을 회귀로부터 지키기 위해 테스트만 추가했다:

- `test_isolation_forest_is_trained_once_not_per_request` — 모델 캐싱 보장.
- `test_concurrent_max_size_requests_are_race_free_and_deterministic` — 동시성/
  무상태 보장.

## 보류(범위 밖)

- 동기 엔드포인트는 CPU 바운드 작업을 Starlette 스레드풀에서 처리한다. 이는
  수평 확장(다중 프로세스/인스턴스)로 대응할 문제이며, 인증·DB·영구 저장을
  추가하지 않는다는 원칙과도 무관하므로 이번 검토에서는 코드를 바꾸지 않았다.
- 다중 uvicorn 워커/프로세스로 배포 시 각 프로세스가 독립적으로 모델을 1회
  학습하는 것은 무상태 설계상 의도된 동작이며 버그가 아니다.

## 테스트 결과

```
python -m pip install -r requirements-dev.txt && python -m pytest -q
30 passed, 2 warnings
```
