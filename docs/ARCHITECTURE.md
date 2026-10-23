# Sudor: architecture

How Sudor is built, what runs where, and why. Every diagram below is drawn by GitHub from the text in this file, so
it can be zoomed and panned in place, and it changes when the file does. A printable copy is in
[architecture.pdf](architecture.pdf).

What is described here is what runs. It was checked against the AWS account on 23 October 2026: the people table holds
255 records, the alert check runs every ten minutes and both of its alarms read OK.

**Contents.** [At a glance](#at-a-glance) · [1. Context](#1-context-who-and-what-it-talks-to) ·
[2. On AWS](#2-on-aws-what-runs-where) · [3. Inside the server](#3-inside-the-server) ·
[4. A voice turn](#4-a-voice-turn-from-sentence-to-spoken-answer) · [5. The decision](#5-the-decision-for-this-body) ·
[6. Alerts](#6-alerts-when-nobody-asks) · [7. The data](#7-the-data-what-a-person-record-holds) ·
[8. Consent](#8-consent-who-may-be-told) · [9. Security and privacy](#9-security-and-privacy) ·
[10. Shipping it](#10-shipping-it) · [11. Decisions](#11-decisions-and-why)

## At a glance

| | |
|---|---|
| Protocol | MCP 2025-11-25 over Streamable HTTP, stateless: a new server and transport per request |
| Surface | 18 tools by default, an MCP Apps panel and card, an Agent Skill as `skill://` resources |
| Answer time | Under 40 ms at p95 for every in-memory tool ([LATENCY.md](../LATENCY.md)); Alexa+ allows about 500 ms |
| Data in | Weather, warnings, cooling centres, outages, recalls and space weather, read on timers, never inside a turn |
| Where it runs | One EC2 instance (t4g.micro, arm64) behind an API Gateway HTTP API, us-east-1, shared with Orbita |
| Where people live | DynamoDB `sudor-people`, one sealed item per person, versioned writes, on-demand |
| Alerts | A Lambda run by EventBridge Scheduler every 10 minutes, alarmed in CloudWatch |
| Telling the family | Amazon SES for email, Amazon SNS for urgent texts, only after the family member agrees |
| Code | TypeScript on Node 20, about 19,600 lines in `src/`, 2,835 automated checks |

## 1. Context: who and what it talks to

A person (or their family) asks; Alexa+, or the stand-in on the demo page, chooses a tool; Sudor answers from data it
already holds. Everything on the right is public data, read in the background.

```mermaid
flowchart LR
  subgraph Ask["Who asks"]
    P(["The person at home<br/>their medicines, conditions, home"])
    F(["Family<br/>with a share code, read only"])
  end
  H["Alexa+<br/>or the demo's stand-in:<br/>a Claude model reading tools/list"]
  S["<b>Sudor</b><br/>MCP server"]
  subgraph Out["Who it tells"]
    E(["Family by email<br/>after they agree"])
    T(["Family by text<br/>urgent only, after they agree"])
  end
  subgraph Data["Public data"]
    W["Open-Meteo<br/>forecast, UV, air quality, archive"]
    A["NWS, MeteoAlarm, INMET,<br/>SACHET, WMO SWIC<br/>official warnings"]
    C["27 county and city lists<br/>cooling and warming centres"]
    M["CDC guidance, RxNorm and RxClass,<br/>openFDA labels and recalls"]
    O["Utility and state outage maps<br/>NOAA space weather"]
    L["Amazon Location Service<br/>and Medicare's hospital list"]
  end
  R["Orbita<br/>sister add-on, over MCP"]
  P --> H
  F --> H
  H -- "MCP, OAuth 2.1 + PKCE" --> S
  R -- "heat check for a crew,<br/>no health data crosses" --> S
  Data --> S
  S --> E
  S --> T
```

## 2. On AWS: what runs where

```mermaid
flowchart TB
  U(["Alexa+ or a browser"]) --> G["API Gateway HTTP API<br/>2f2opzcjui.execute-api.us-east-1"]
  G -- "origin secret header" --> EC2
  subgraph EC2["EC2 t4g.micro, arm64 (shared with Orbita)"]
    N["Node 20, systemd unit <code>sudor</code><br/>hardened: no new privileges,<br/>read-only system, own user"]
  end
  N <--> D[("DynamoDB<br/>sudor-people<br/>on-demand, PITR, TTL")]
  SSM["SSM Parameter Store<br/>/sudor/* keys and settings"] --> N
  N --> SES["Amazon SES<br/>family email"]
  N --> SNS["Amazon SNS<br/>urgent texts"]
  N --> LOC["Amazon Location Service<br/>nearest hospital"]
  EB["EventBridge Scheduler<br/>every 10 minutes"] --> LA["Lambda <code>sweep</code><br/>container image"]
  LA <--> D
  LA --> SES
  LA -. "fails or stops" .-> CW["CloudWatch alarms"] --> AL["SNS alarm topic"]
  S3["S3 deploy bucket"] -- "SSM Run Command" --> EC2
```

The server and the alert check share nothing but the table. The server answers questions; the Lambda does the work
nobody is there to watch. If the server crashes the alerts still go, and if the alerts stop, an alarm says so.

## 3. Inside the server

```mermaid
flowchart LR
  subgraph Edge["Every request"]
    O1["requireOrigin<br/>only through the gateway"] --> RL["rate limit"] --> AU["requireAuth<br/>account or demo id"]
  end
  AU --> MCP["New McpServer + transport<br/>per request"]
  MCP --> T["18 tools<br/>src/tools/*.ts"]
  T --> DEC["Decisions in code<br/>domain.ts, personal.ts, firstaid.ts,<br/>indoor.ts, indoorcold.ts, hazard.ts"]
  DEC --> MEM[("In memory<br/>forecasts, warnings, centres,<br/>outages, recalls")]
  T <--> ST["store.ts<br/>vault.ts seals, table.ts writes"]
  BG["background.ts timers<br/>weather 20 min, warnings 10 min,<br/>centres 30 min, recalls 6 h"] --> MEM
  T --> FL["flow.ts<br/>names the next step"]
```

A tool never calls the internet inside a turn. Somebody saying "I live in Phoenix" is answered at once, and the
place is looked up in the background (`locationStatus`), because geocoding alone can take longer than Alexa+ allows
for a whole turn.

## 4. A voice turn, from sentence to spoken answer

```mermaid
sequenceDiagram
  autonumber
  actor D as Dolores
  participant A as Alexa+ (or the stand-in)
  participant G as API Gateway
  participant S as Sudor
  participant M as Memory
  D->>A: "Is it safe for me to go out?"
  A->>G: tools/call weather_check (MCP, bearer token)
  G->>S: forwarded, with the origin secret
  S->>S: origin, rate limit, auth, new McpServer
  S->>M: her forecast, her warnings, her record
  M-->>S: already there, read on a timer
  S->>S: heat index x her metoprolol x her cooling
  S-->>A: answer text, card, nextAction (under 40 ms)
  A-->>D: "Better to stay in. Your metoprolol blocks sweating. Is your cooling working?"
```

The model chooses the tool and says the words. It does not decide the answer: every verdict, number and safety line
is written by code, so no model can soften "call 911" or turn "stay in" into "probably fine".

## 5. The decision, for this body

```mermaid
flowchart TD
  Q["A question"] --> EM{"Any sign of an emergency?<br/>not breathing, chest pain,<br/>stroke signs, seizure, heat stroke"}
  EM -- yes --> E911["Call the country's number now<br/>first aid for that sign<br/>nearest emergency department<br/>family told"]
  EM -- no --> HZ{"An official warning<br/>where they live?"}
  HZ -- yes --> STEPS["Steps for this person:<br/>insulin, oxygen, dialysis,<br/>whether to leave"]
  HZ -- no --> W["The forecast hour by hour"]
  W --> B["x their medicines, by mechanism<br/>blocks sweating, blunts thirst,<br/>fluid loss, burns faster"]
  B --> C["x their conditions and age<br/>a learned limit that only tightens"]
  C --> H{"Is home safe?<br/>cooling or heating working?"}
  H -- yes --> V["Fine, take care, or stay in<br/>with the reason and the best hours"]
  H -- no --> GO["Indoors is the danger:<br/>the nearest open centre,<br/>and the family who agreed"]
```

A source that could not be read is never counted as safe: the answer says it could not check.

## 6. Alerts, when nobody asks

```mermaid
sequenceDiagram
  participant EB as EventBridge (every 10 min)
  participant L as Lambda sweep
  participant D as DynamoDB
  participant W as Weather and warnings
  participant F as Family (SES / SNS)
  EB->>L: start (one at a time, 5 min timeout, no retry)
  L->>D: people with somebody to tell
  L->>W: forecast and warnings, 6 places at once
  L->>L: five checks: a warning, alone and not heard from by 2 pm,<br/>home too hot, home too cold, a stay-in day tomorrow
  L->>D: write "sent" first (versioned write)
  L->>F: one message, with a stop link, nothing about health
```

Writing what was sent before sending it means a crash can lose one email but never send two. The public demo never
sends anything, so sandbox records cost the check nothing.

## 7. The data: what a person record holds

```mermaid
classDiagram
  class Person {
    medications: generic, class, mechanisms
    recallWatch: names
    conditions: ids
    age, livesAlone, checkInHour
    cooling, heating, indoor reading
    equipment: oxygen, dialysis, pump
    lat, lon, locationName, country
    privacy: say names aloud or not
    alertsSent: one per kind per day
  }
  class Contact {
    name, email, phone
    invitedAt, agreedAt
    stop token
  }
  class Household {
    members: baby, child, teen, adult, older adult
    their medicines and conditions, no names for children
  }
  class Item {
    id
    body: sealed JSON
    v: version
    ttl: sandbox only, 7 days
  }
  Person "1" --> "*" Contact
  Person "1" --> "*" Household
  Person ..> Item : stored as
```

In DynamoDB a person is one item: the record as JSON, sealed with AES-256-GCM when a data key is set, a version that
every write must match, and for sandbox records a TTL so DynamoDB deletes them itself after a week.

## 8. Consent: who may be told

```mermaid
stateDiagram-v2
  [*] --> Invited: "Tell my daughter Priya"
  Invited --> Agreed: Priya taps Yes on her own phone
  Invited --> Removed: Priya taps No
  Agreed --> Removed: stop link in any message
  Removed --> [*]
  note right of Agreed
    Only now can Sudor email her,
    or text her if she added her number.
    Messages say where and what to do,
    never a medicine or a condition.
  end note
```

## 9. Security and privacy

- **Health data sealed at rest.** AES-256-GCM, a fresh nonce per write, a key id for rotation, and the purpose bound in
  as associated data (`src/vault.ts`).
- **Only through the gateway.** The instance accepts a request only with the gateway's origin secret
  (`src/origin.ts`).
- **Account linking.** OAuth 2.1 with PKCE in the static-client shape Alexa+ uses (`src/auth.ts`).
- **The demo is fenced.** Each browser gets its own 128-bit sandbox id, never an account; the model has a daily cap and
  a per-caller burst limit; the demo never sends email or text.
- **Said aloud only if they want.** With privacy on, answers say "one of your medicines" instead of its name.
- **Keys in SSM**, never in the image or the repository.

## 10. Shipping it

```mermaid
flowchart LR
  C["git commit"] --> CI["GitHub Actions<br/>Node 20 and 22, live weather,<br/>CDK stack, DynamoDB Local, Docker"]
  C --> B["deploy/bundle.sh<br/>build, tar, upload to S3"]
  B --> R["SSM Run Command<br/>untar, npm ci, restart sudor"]
  R --> H["/health"]
  I["infra/ (CDK)"] --> T[("table, Lambda,<br/>schedule, alarms")]
```

## 11. Decisions, and why

- **Stateless MCP.** A new server per request is simple to reason about and lets two add-ons share one small instance.
- **Feeds on timers, answers from memory.** Alexa+ allows about half a second for a whole turn; a forecast fetch alone
  can take longer. So nothing external is called inside a turn.
- **The model talks; code decides.** The one place a model is allowed is choosing the tool and phrasing the words. The
  verdict is arithmetic over published guidance, so it can be tested, and it is: 2,835 checks.
- **Consent belongs to the person told.** The person at home cannot sign their family up. Each family member agrees on
  their own phone, and can stop with one tap.
- **The alert check is its own process.** It is the part nobody is there to watch, so it runs apart from the server and
  is alarmed when it fails or stops.
- **Honest about what it cannot do.** It cannot phone anyone or reach 911, and says so. A source it could not read is
  "could not check", never "all clear".
