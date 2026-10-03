# Pacta — program on-chain (Anchor): zasady i zakres pracy

> Ten plik jest instrukcją dla agenta (Claude Code) pracującego w repozytorium programu Solana.
> Skopiuj go do root repo Anchora jako `CLAUDE.md`. Backend (Symfony) i frontend (React) żyją w osobnych repozytoriach i czytają to, co ten program zapisze na chainie.

## 1. Czym jest Pacta i jaka jest Twoja rola

Pacta pozwala freelancerom, którzy się nie znają, wspólnie przyjąć zlecenie. Klient wpłaca pieniądze do escrow, a po akceptacji każdego etapu (milestone'u) program **sam** dzieli je między portfele zespołu według procentów uzgodnionych przed startem pracy.

Projekt hackathonowy: HackYeah 2026, wyzwanie Superteam Poland „Finance Without Intermediaries”. Jury ocenia przede wszystkim to, czy **logika zastępująca pośrednika znajduje się w programie on-chain**. Cytat z briefu: „jeśli warunki transakcji egzekwuje Twój backend, pośrednik nie zniknął, zmienił się w Ciebie”.

Twoja rola: napisać, przetestować i zdeployować na **devnet** program Anchor, który jest jedynym miejscem decydującym o pieniądzach. Backend i frontend nigdy nie przelewają środków. Backend przechowuje tylko opisy i czyta stan Twoich kont.

Jury zapyta (przygotuj odpowiedzi w README):
- Gdzie dokładnie w kodzie znika pośrednik? Która instrukcja egzekwuje warunki, których nikt nie może obejść?
- Co się stanie, gdy jedna ze stron zniknie w połowie? Gdzie są środki i kto może je odzyskać?
- Kto ma uprawnienia do jakich operacji? Czy autor może coś zmienić po deployu?
- Dlaczego blockchain, a nie baza danych?

## 2. Środowisko

- Rust (stable), Solana CLI / Agave 2.x, Anchor przez `avm` (0.31 lub nowszy), Node 20+, yarn lub pnpm.
- Alternatywa bez instalacji: dev container Superteam `github.com/matzayonc/solana-live-course-2026` albo Solana Playground.
- Sieć: **wyłącznie devnet**. Żadnego mainnetu, żadnych prawdziwych pieniędzy.
- Token: klasyczny **SPL Token** (`anchor-spl`, `token` + `associated_token`). Token-2022 nie jest potrzebny.

```bash
anchor init pacta            # jeśli repo jest puste; nazwa crate'a MUSI być `pacta`
anchor build
anchor keys sync             # wpisuje adres programu do lib.rs i Anchor.toml
anchor test                  # lokalny walidator
solana config set --url devnet && solana airdrop 2
anchor deploy --provider.cluster devnet
```

Nazwa crate'a `pacta` jest ważna: backend oczekuje pliku `target/idl/pacta.json`.

## 3. Model danych (konta)

Trzy typy kont PDA plus skarbiec tokenów. Wszystkie udziały w **basis points** (10 000 = 100%), żadnych floatów. Limity rozmiarów stałe (`#[max_len]`), bo Anchor musi znać rozmiar konta z góry.

```rust
// Seeds — MUSZĄ być dokładnie takie, backend liczy te same PDA u siebie
// project   = ["project",   client.key(), seed.to_le_bytes()]        // seed: u64 wybrany przez klienta (frontend losuje)
// milestone = ["milestone", project.key(), index.to_le_bytes()]      // index: u8, numeracja od 0
// vault     = ["vault",     project.key()]                           // konto tokenowe SPL, authority = project PDA

#[account]
#[derive(InitSpace)]
pub struct Project {
    pub client: Pubkey,
    pub seed: u64,
    pub mint: Pubkey,                 // np. devnetowe USDC
    pub arbiter: Option<Pubkey>,      // None = brak sporów możliwych (MVP: wymagaj Some)
    pub status: ProjectStatus,        // Draft | Active | Completed | Cancelled
    #[max_len(8)]
    pub members: Vec<Member>,         // zespół; bez klienta
    pub milestone_count: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Member {
    pub wallet: Pubkey,
    pub role: u8,                     // 0 backend, 1 frontend, 2 design, 3 qa, 4 other — tylko etykieta
    pub accepted: bool,
}

#[account]
#[derive(InitSpace)]
pub struct Milestone {
    pub project: Pubkey,
    pub index: u8,
    pub amount: u64,                  // w najmniejszych jednostkach tokena (USDC: 6 miejsc)
    pub status: MilestoneStatus,      // Draft | Funded | InProgress | Submitted | ChangesRequested | Disputed | Paid | Cancelled
    #[max_len(8)]
    pub allocations: Vec<Allocation>, // suma bps == 10_000, każdy wallet musi być w Project.members
    pub dispute: Option<Dispute>,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Allocation { pub wallet: Pubkey, pub bps: u16 }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Dispute {
    pub opened_by: Pubkey,
    pub resolution: Option<Resolution>,   // None = otwarty
}

// Zamknięta lista decyzji arbitra: ile dla zespołu (reszta wraca do klienta)
pub enum Resolution { Team100, Team75, Team50, Team25, Client100 }
```

Zasady modelu:
- Enumy bez danych (statusy, `Resolution`) są kodowane jako `u8` w kolejności wariantów. **Nie zmieniaj kolejności wariantów po tym, jak backend napisze dekodery.** Dodawaj nowe na koniec.
- Nie dodawaj pól tekstowych (tytuły, opisy). To jest off-chain w backendzie. Na chainie są adresy, kwoty, procenty, statusy.
- Każda zmiana struktury konta = nowy `anchor build` + przekazanie nowego IDL do backendu (patrz §7).

## 4. Instrukcje

Kolejność odpowiada cyklowi `CREATE → AGREE → FUND → WORK → ACCEPT → SPLIT`. Przy każdej instrukcji: kto podpisuje, jaki stan wejściowy, jaki wyjściowy.

| Instrukcja | Signer | Warunki wejścia | Efekt |
|---|---|---|---|
| `create_project(seed, mint, arbiter, members[])` | client | brak konta | `Project` w `Draft`, `accepted=false` dla wszystkich |
| `create_milestone(index, amount, allocations[])` | client | `Project.status == Draft`, `index == milestone_count`, suma bps = 10 000, każdy wallet ∈ members, `amount > 0` | `Milestone` w `Draft`, `milestone_count += 1` |
| `accept_contract()` | member | signer ∈ members, `accepted == false`, `milestone_count > 0` | `accepted = true`; gdy wszyscy zaakceptowali → `Project.status = Active` |
| `fund_milestone(index)` | client | `Project.status == Active`, `Milestone.status == Draft` | `transfer_checked` z ATA klienta do `vault` na dokładnie `amount`; status `Funded` |
| `start_milestone(index)` | member | status `Funded` lub `ChangesRequested` | status `InProgress` (opcjonalne w MVP; można przejść `Funded → Submitted`) |
| `submit_milestone(index)` | member | status `Funded`, `InProgress` lub `ChangesRequested` | status `Submitted` |
| `accept_milestone(index)` | client | status `Submitted` | wypłata wg `allocations` z `vault` na ATA członków (signer seeds project PDA); status `Paid` |
| `request_changes(index)` | client | status `Submitted` | status `ChangesRequested`, środki zostają w vault |
| `open_dispute(index)` | client **lub** member | status `Submitted` lub `ChangesRequested`, `arbiter.is_some()` | status `Disputed`, `dispute = Some{opened_by, None}` |
| `resolve_dispute(index, resolution)` | arbiter | status `Disputed`, signer == `Project.arbiter` | część zespołu dzielona wg `allocations`, reszta wraca na ATA klienta; status `Paid` (lub `Cancelled` przy `Client100`) |
| `cancel_unstarted_milestone(index)` | client | status `Draft` lub `Funded` (nikt nie wystartował / nie oddał) | jeśli `Funded`: zwrot na ATA klienta; status `Cancelled` |

Czego **nie ma** i nie może być:
- żadnej instrukcji `admin_withdraw`, `set_allocation`, `update_project` po aktywacji, `close_vault` poza ścieżkami refundu,
- żadnej instrukcji, którą może wywołać portfel spoza `{client, members, arbiter}`,
- arbiter nie może przelać środków do siebie: `resolve_dispute` wypłaca wyłącznie na `allocations` i do klienta.

Wypłata do N członków: użyj `remaining_accounts` z ATA członków w kolejności `allocations`. Sprawdź dla każdego, że `ata.owner == allocation.wallet` i `ata.mint == project.mint`. Zaokrąglenie: `amount * bps / 10_000` w dół (`u128` pośrednio), reszta groszowa (max kilka jednostek) trafia do ostatniego członka albo zostaje w vault; wybierz jedno i opisz w README.

Emituj eventy Anchor (`emit!`) dla: `ContractAccepted`, `MilestoneFunded`, `MilestoneSubmitted`, `MilestoneAccepted`, `PaymentDistributed{wallet, amount}`, `DisputeOpened`, `DisputeResolved`, `MilestoneCancelled`. Backend czyta je z logów transakcji.

## 5. Reguły bezpieczeństwa (checklista do każdej instrukcji)

1. **Signer check**: `Signer<'info>` plus `constraint = signer.key() == project.client` (albo `members.iter().any(...)`, albo `== arbiter`).
2. **State check**: `require!(milestone.status == X, PactaError::InvalidStatus)`. Każde przejście stanu jest jawne, nie ma „domyślnego” przejścia.
3. **PDA check**: wszystkie konta przez `seeds = [...]`, `bump = account.bump`. `Milestone.project` musi równać się kluczowi przekazanego `Project` (`has_one = project`).
4. **Mint check**: `vault.mint == project.mint`, `client_ata.mint == project.mint`, ATA każdego odbiorcy tak samo.
5. **Suma bps = 10 000** przy tworzeniu milestone'u, allocations niemutowalne po utworzeniu. Brak duplikatów walletów w allocations.
6. **Brak floatów**: `u64`/`u128`, `checked_mul`, `checked_div`, błędy przy overflow.
7. **Izolacja escrow**: jeden vault na projekt, authority = project PDA. Nigdy nie przelewaj między vaultami różnych projektów.
8. **Fund na pełną kwotę**: `fund_milestone` przelewa dokładnie `amount`, nie przyjmuje kwoty z argumentu.
9. Po `Paid`/`Cancelled` milestone jest terminalny. Nie ma reaktywacji.
10. Odpowiedź na „czy autor może coś zmienić po deployu”: na devnecie program ma upgrade authority (potrzebne do iteracji w czasie hackathonu). Zapisz w README, że w produkcji authority zostaje przekazane do multisig albo ustawione na `--final`. **Nie ustawiaj `--final` w czasie hackathonu**, zablokuje poprawki.

## 6. Testy

`anchor test` (TypeScript, lokalny walidator). Minimum:

- **Happy path (obowiązkowy, to jest demo)**: klient + 3 członków, 1 milestone 1 000 USDC, podział 40/35/25 → po `accept_milestone` salda ATA: 400 / 350 / 250, vault = 0, status `Paid`.
- `create_milestone` z sumą bps ≠ 10 000 → błąd.
- `create_milestone` z walletem spoza zespołu → błąd.
- `accept_contract` z obcego portfela → błąd; po ostatnim podpisie `Project.status == Active`.
- `fund_milestone` przed aktywacją → błąd.
- `accept_milestone` przez członka zamiast klienta → błąd.
- `request_changes` → `ChangesRequested`, vault bez zmian, ponowny `submit` działa.
- `open_dispute` → `resolve_dispute(Team75)` przez arbitra: zespół dostaje 750 wg udziałów, klient 250. `resolve_dispute` przez nie-arbitra → błąd.
- `cancel_unstarted_milestone` po `fund` → pełny zwrot do klienta.
- Dwa projekty równolegle: środki nie mieszają się między vaultami.

Testowy mint: utwórz w teście własny mint z 6 miejscami (`createMint`), nie polegaj na faucetach.

## 7. Co dostarczasz backendowi i frontendowi (kontrakt integracyjny)

Po każdym deployu na devnet:

1. **`target/idl/pacta.json`** → backend kopiuje do `resources/idl/pacta.json`, frontend używa z `target/types/pacta.ts`. Zmiana struktury konta lub kolejności wariantów enuma bez przekazania nowego IDL psuje dekodery backendu po cichu.
2. **Adres programu** (`anchor keys list`, także pole `address` w IDL) → backend wpisuje do `.env` jako `PACTA_PROGRAM_ID`.
3. **Seeds PDA** z §3 opisane w README słowo w słowo. Backend derywuje adresy sam, przed wysłaniem transakcji.
4. **Adres testowego mintu USDC** użytego na devnecie → backend `PACTA_USDC_MINT`, frontend konfiguracja.
5. **Fixture**: po utworzeniu pierwszego projektu na devnecie podaj adresy PDA projektu i milestone'u. Backend pobierze surowe dane (`solana account <PDA> --output json`) jako fixture do testów dekoderów.
6. Opcjonalnie: `anchor idl init` publikuje IDL on-chain, dzięki czemu Solana Explorer pokazuje zdekodowane instrukcje. Ładnie wygląda na demo.

Frontend wywołuje Twoje instrukcje przez `@coral-xyz/anchor` + Wallet Adapter. Nazwy instrukcji i argumentów z §4 są kontraktem; zmieniaj je tylko w porozumieniu.

## 8. Przygotowanie demo

Skrypt `scripts/demo-setup.ts` (uruchamiany raz przed prezentacją), który:

- tworzy 4 keypairy w `.keys/` (gitignore!): `client`, `backend-dev`, `frontend-dev`, `designer`, plus `arbiter`,
- zasila je SOL z devnetu (`requestAirdrop`, z retry; faucet bywa kapryśny, więc zrób to dzień wcześniej),
- tworzy testowy mint USDC (6 miejsc) i mintuje 10 000 na ATA klienta,
- tworzy ATA dla wszystkich członków (żeby `accept_milestone` nie musiało ich zakładać),
- wypisuje wszystkie adresy i linki do `explorer.solana.com/address/...?cluster=devnet`.

Trzymaj pod ręką drugi URL RPC (Helius / QuickNode, darmowy plan) w `Anchor.toml` lub zmiennej `ANCHOR_PROVIDER_URL`. Publiczny `api.devnet.solana.com` odpowiada 429 przy większym ruchu z jednego IP, a na sali cały zespół ma jedno IP.

## 9. Priorytety, gdy brakuje czasu

1. `create_project` + `create_milestone` + `accept_contract` (istota: tymczasowy zespół i zgoda wszystkich).
2. `fund_milestone` + vault (usunięcie zaufania klient ↔ zespół).
3. `submit_milestone` + `accept_milestone` z automatycznym podziałem (**najważniejszy moment całego projektu**).
4. `request_changes`, `cancel_unstarted_milestone`.
5. `open_dispute` + `resolve_dispute`.
6. Eventy, `anchor idl init`, polish.

Bez punktów 1-3 nie ma demo. Zrób je end-to-end i zdeployuj zanim zaczniesz 4-6.

## 10. Git i porządek

- Commituj po każdym domkniętym kroku (instrukcja + test, zmiana modelu + nowy IDL). W hackathonie historia git jest dokumentacją dla jury.
- Conventional Commits: `feat(program): add fund_milestone with spl transfer`, `test(program): cover dispute resolution splits`, `build: deploy v3 to devnet`, `docs: describe pda seeds`.
- Każdy deploy na devnet: commit z adresem programu w opisie i zaktualizowanym `Anchor.toml`.
- Nie commituj keypairów (`.keys/`, `target/deploy/*-keypair.json` w `.gitignore`), poza keypairem programu, jeśli zespół świadomie chce zachować stały adres (wtedy traktuj repo jako prywatne do końca hackathonu).
- README repo musi odpowiadać na pytania jury z §1 i wskazywać pliki: gdzie są constraints podpisów, gdzie liczony jest podział, gdzie jest vault.

## 11. Czego NIE robimy

Marketplace, reputacja, DAO, KYC, fiat, mainnet, wymiana członków zespołu (tylko miejsce w modelu: `members` jako `Vec`), wielu arbitrów, deadline'y (chyba że zostanie czas po §9 pkt 5). Najpierw ma działać pełny finansowy flow na devnecie, widoczny w Explorerze.
