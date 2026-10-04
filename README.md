# Pacta: program on-chain (Anchor)

Pacta pozwala freelancerom, którzy się nie znają, wspólnie przyjąć zlecenie. Klient wpłaca pieniądze do escrow, a po akceptacji każdego etapu (milestone'u) **program sam** dzieli je między portfele zespołu według procentów uzgodnionych przed startem pracy.

HackYeah 2026, wyzwanie Superteam Poland „Finance Without Intermediaries”.

| | |
|---|---|
| Sieć | **devnet** (wyłącznie) |
| Program ID | `AgSfAvkXWBugaYg768AAZdpUT3oNYkx7JQGmZTrUwHWK` |
| Testowy mint USDC (6 miejsc) | `6VLBMnVsHDDmg6a4tDqo9X4hMiCAZuuVDYJrivMVjvF9` |
| IDL on-chain | `FmrWs3YPr5iab3MQZkkYWANoRH9Dj1rC2nWCYeHx5Avw` (Explorer dekoduje instrukcje) |
| Explorer | https://explorer.solana.com/address/AgSfAvkXWBugaYg768AAZdpUT3oNYkx7JQGmZTrUwHWK?cluster=devnet |

## Pytania jury

### Gdzie dokładnie w kodzie znika pośrednik?

Pośrednikiem byłby ktoś, kto trzyma pieniądze i decyduje, komu je wypłacić. W Pacta to robi program:

- **Pieniądze trzyma vault, którego właścicielem jest PDA projektu, a nie żaden portfel.** Vault powstaje w [`create_project.rs:24-35`](programs/pacta/src/instructions/create_project.rs) (`token::authority = project`). Klucz prywatny do PDA nie istnieje, więc podpisać przelew z vaultu może tylko program, i to tylko w kodzie [`payout.rs`](programs/pacta/src/payout.rs).
- **Podział jest zapisany przed pracą i nie da się go zmienić.** `create_milestone` ([`create_milestone.rs:33`](programs/pacta/src/instructions/create_milestone.rs)) wymaga sumy 10 000 bps, portfeli wyłącznie z zespołu i braku duplikatów. Po pierwszym podpisie członka zespołu milestone'ów nie można już dodawać (`ContractAlreadySigned`), a żadna instrukcja nie modyfikuje `allocations`.
- **Wypłata dzieje się w tej samej transakcji co akceptacja.** [`accept_milestone.rs:49`](programs/pacta/src/instructions/accept_milestone.rs) woła `payout::distribute_to_team` ([`payout.rs:78`](programs/pacta/src/payout.rs)), który liczy udziały ([`payout::split`, `payout.rs:16`](programs/pacta/src/payout.rs)) i przelewa je z vaultu na konta tokenowe członków. Każde konto odbiorcy jest sprawdzane: właściciel == wallet z allocations, mint == mint projektu ([`payout.rs:97-99`](programs/pacta/src/payout.rs)).
- **Wpłata to zawsze dokładnie uzgodniona kwota.** `fund_milestone` ([`fund_milestone.rs:50`](programs/pacta/src/instructions/fund_milestone.rs)) nie przyjmuje kwoty z argumentu, bierze `milestone.amount`.

Backend i frontend nigdy nie przelewają środków. Backend przechowuje opisy i czyta stan kont.

### Co się stanie, gdy jedna ze stron zniknie w połowie?

Środki leżą w vaultcie projektu (`["vault", project]`) do czasu, aż jedna z jawnych ścieżek je wypuści:

| Sytuacja | Kto może odblokować | Ścieżka |
|---|---|---|
| Klient ufundował, zespół nie zaczął | klient | `cancel_unstarted_milestone`: pełny zwrot na ATA klienta |
| Zespół oddał pracę, klient zniknął | członek zespołu | `open_dispute` (z `Submitted`/`ChangesRequested`), arbiter rozstrzyga (np. `Team100`) |
| Klient prosi o poprawki w nieskończoność | członek zespołu | `open_dispute` z `ChangesRequested` |
| Zespół zaczął (`InProgress`) i zniknął | klient | `open_dispute` z `InProgress`, arbiter rozstrzyga (np. `Client100`: pełny zwrot) |
| Część zespołu zniknęła przed podpisaniem umowy | nikt nie traci pieniędzy | projekt zostaje w `Draft`, `fund_milestone` wymaga `Active` |

Znane ograniczenie MVP: jeśli zniknie **arbiter** w trakcie sporu, środki zostają w vaultcie. Rozwiązaniem byłyby deadline'y z domyślnym rozstrzygnięciem; są poza zakresem hackathonu (CLAUDE.md §11).

### Kto ma uprawnienia do jakich operacji?

| Instrukcja | Podpisuje | Status wejściowy → wyjściowy |
|---|---|---|
| `create_project(seed, mint, arbiter, members)` | client | (brak konta) → projekt `Draft` |
| `create_milestone(index, amount, allocations)` | client | projekt `Draft`, nikt jeszcze nie podpisał → milestone `Draft` |
| `accept_contract()` | członek zespołu | projekt `Draft` → `Active` po ostatnim podpisie |
| `fund_milestone(index)` | client | projekt `Active`, milestone `Draft` → `Funded` |
| `start_milestone(index)` | członek zespołu | `Funded`/`ChangesRequested` → `InProgress` |
| `submit_milestone(index)` | członek zespołu | `Funded`/`InProgress`/`ChangesRequested` → `Submitted` |
| `request_changes(index)` | client | `Submitted` → `ChangesRequested` |
| `accept_milestone(index)` | client | `Submitted` → `Paid` (wypłata wg allocations) |
| `open_dispute(index)` | client lub członek | `Submitted`/`ChangesRequested`/`InProgress` → `Disputed` |
| `resolve_dispute(index, resolution)` | arbiter | `Disputed` → `Paid` (lub `Cancelled` przy `Client100`) |
| `cancel_unstarted_milestone(index)` | client | `Draft`/`Funded` → `Cancelled` (zwrot, jeśli był `Funded`) |

- Nie istnieje żadna instrukcja administracyjna (`admin_withdraw`, `set_allocation`, `update_project`, `close_vault`). Środki opuszczają vault wyłącznie w `accept_milestone`, `resolve_dispute` i `cancel_unstarted_milestone`.
- Każda instrukcja odrzuca portfele spoza `{client, members, arbiter}`. Klient i członkowie są sprawdzani przez `has_one = client` lub [`Project::require_member`/`require_client`](programs/pacta/src/state.rs), arbiter przez `constraint = project.arbiter == Some(arbiter)` ([`resolve_dispute.rs:19`](programs/pacta/src/instructions/resolve_dispute.rs)).
- **Arbiter nie może przelać środków do siebie.** Arbiter nie może być klientem ani członkiem zespołu ([`create_project.rs:53,63`](programs/pacta/src/instructions/create_project.rs)), więc nie występuje w `allocations`. `resolve_dispute` płaci tylko na konta z allocations i na ATA klienta. Wybiera z zamkniętej listy `Team100 | Team75 | Team50 | Team25 | Client100`.
- Każde przejście stanu jest jawne (`require!(status == …)`), `Paid` i `Cancelled` są terminalne.

### Czy autor może coś zmienić po deployu?

Na devnecie program ma upgrade authority (portfel deployera), bo w czasie hackathonu musimy wdrażać poprawki. W produkcji authority zostaje przekazane do multisig (np. Squads) albo program jest zamrażany przez `solana program set-upgrade-authority <PROGRAM_ID> --final`. Od tego momentu reguły z tego repo są ostateczne dla wszystkich stron, łącznie z autorem.

Autor nie ma żadnych uprawnień do środków **także teraz**: w kodzie nie ma klucza „admina”, a vault należy do PDA projektu.

### Dlaczego blockchain, a nie baza danych?

- Baza danych należy do kogoś. Ten ktoś może zmienić podział, wstrzymać wypłatę albo zbankrutować z pieniędzmi klienta. Tutaj escrow nie ma właściciela, a reguły podziału są publicznym kodem, który każdy może zweryfikować.
- Freelancerzy się nie znają. Zamiast ufać sobie nawzajem albo platformie, ufają programowi, którego zachowanie widać w Explorerze.
- Wypłata do N osób dzieje się atomowo, w jednej transakcji: albo wszyscy dostają swoją część, albo nikt.
- Historia (kto podpisał, kiedy wpłacono, kto zaakceptował) to niezmienialny log transakcji i eventów.

## Mapa kodu

| Co | Gdzie |
|---|---|
| Konta, enumy, seeds | [`programs/pacta/src/state.rs`](programs/pacta/src/state.rs) |
| Podział i wszystkie przelewy z vaultu | [`programs/pacta/src/payout.rs`](programs/pacta/src/payout.rs) |
| Vault (tworzenie, authority = PDA projektu) | [`instructions/create_project.rs`](programs/pacta/src/instructions/create_project.rs) |
| Constraints podpisów i PDA | `#[derive(Accounts)]` w każdym pliku [`instructions/`](programs/pacta/src/instructions) |
| Przejścia statusów bez ruchu tokenów | [`instructions/milestone_status.rs`](programs/pacta/src/instructions/milestone_status.rs) |
| Błędy | [`programs/pacta/src/errors.rs`](programs/pacta/src/errors.rs) |
| Eventy | [`programs/pacta/src/events.rs`](programs/pacta/src/events.rs) |
| Testy integracyjne | [`tests/pacta.ts`](tests/pacta.ts) |

## Zaokrąglenia

Udział = `amount * bps / 10_000` w dół (pośrednio `u128`, `checked_*`). **Reszta groszowa trafia do ostatniego członka w `allocations`**, więc vault po wypłacie zawsze ma 0 i nic nie zostaje zablokowane. Reszta to maksymalnie `len(allocations) - 1` najmniejszych jednostek (przy USDC: < 0,00001 USDC). Testy jednostkowe: `cargo test -p pacta`.

W `resolve_dispute` część zespołu = `amount * team_bps / 10_000` w dół, reszta wraca do klienta.

## Kontrakt integracyjny (backend / frontend)

### PDA seeds

```
project   = ["project",   client.key(), seed.to_le_bytes()]     // seed: u64 (8 bajtów LE), losuje frontend
milestone = ["milestone", project.key(), index.to_le_bytes()]   // index: u8 (1 bajt), numeracja od 0
vault     = ["vault",     project.key()]                        // konto tokenowe SPL, authority = project PDA
```

### Enumy (kodowane jako `u8` w tej kolejności, nowe warianty tylko na koniec)

```
ProjectStatus:   0 Draft, 1 Active, 2 Completed, 3 Cancelled
MilestoneStatus: 0 Draft, 1 Funded, 2 InProgress, 3 Submitted, 4 ChangesRequested, 5 Disputed, 6 Paid, 7 Cancelled
Resolution:      0 Team100, 1 Team75, 2 Team50, 3 Team25, 4 Client100
Member.role:     0 backend, 1 frontend, 2 design, 3 qa, 4 other
```

### Odstępstwa od briefu (do wiadomości backendu)

- `Project` ma dodatkowe pole na końcu: `closed_milestone_count: u8`. Projekt przechodzi w `Completed`, gdy wszystkie milestone'y są w `Paid`/`Cancelled`. `ProjectStatus::Cancelled` jest zarezerwowany, program go na razie nie ustawia.
- `create_project` przyjmuje `members: Vec<MemberInput { wallet, role }>` (bez `accepted`, zawsze startuje jako `false`). Wymaga też konta `mint`, równego argumentowi `mint`.
- `arbiter` jest wymagany (`Some`), nie może być klientem ani członkiem zespołu.
- `create_milestone` jest zablokowane po pierwszym `accept_contract` (żeby nikt nie podpisał umowy, która potem się zmieni).
- `open_dispute` jest dozwolone także z `InProgress` (ochrona klienta, gdy zespół zniknie po starcie).
- Instrukcje `start_milestone`, `submit_milestone`, `request_changes`, `open_dispute` mają wspólny zestaw kont: `signer`, `project`, `milestone`.
- `accept_milestone` i `resolve_dispute`: konta tokenowe członków w `remaining_accounts` (writable), w kolejności `milestone.allocations`. Dla `resolve_dispute(Client100)` można je pominąć.

### Eventy

`ProjectCreated`, `MilestoneCreated`, `ContractAccepted`, `MilestoneFunded`, `MilestoneStarted`, `MilestoneSubmitted`, `ChangesRequested`, `MilestoneAccepted`, `PaymentDistributed{wallet, amount}`, `DisputeOpened`, `DisputeResolved`, `MilestoneCancelled`. Pola: [`events.rs`](programs/pacta/src/events.rs).

### Po każdym deployu

1. `target/idl/pacta.json` → backend `resources/idl/pacta.json`. `target/types/pacta.ts` → frontend.
2. Program ID → backend `.env` `PACTA_PROGRAM_ID`.
3. Mint USDC (z `.keys/demo.json`) → backend `PACTA_USDC_MINT`, konfiguracja frontendu.
4. Fixture: `yarn demo:flow status` wypisuje komendy `solana account <PDA> --output json` dla projektu i milestone'u.

### Fixture z devnetu (projekt demo po pełnym flow: `Completed`, milestone `Paid`, 400/350/250)

```
project   EmHoe2ujUZEyfXnoNWt9TZniptgjygVE2WSpHXqfi73e
milestone CUNjDu8ZYsLQTYtyyAUuGz5Pyyw3LZL6txVq6yk2hNms
vault     (PDA ["vault", project])

solana account EmHoe2ujUZEyfXnoNWt9TZniptgjygVE2WSpHXqfi73e --output json -u devnet > project.json
solana account CUNjDu8ZYsLQTYtyyAUuGz5Pyyw3LZL6txVq6yk2hNms --output json -u devnet > milestone.json
```

Transakcja z automatycznym podziałem: https://explorer.solana.com/tx/3Fami5ajaFCXM9CxoHNKLeGsfEK8ZbLoFrP8Ykos8TkmqVNq8C6iNgwppHnP42ygXZkkVgAmZSvosBrVuhtxQNEt?cluster=devnet

## Środowisko

- Rust (rustup), Solana CLI Agave 2.3.0, Anchor 0.32.1 (`avm install 0.32.1 && avm use 0.32.1`), Node 20+, yarn.
- Platform-tools Agave 2.3 mają cargo 1.84. Dlatego program deklaruje `rust-version = "1.84"`, a [`.cargo/config.toml`](.cargo/config.toml) włącza resolver zgodny z MSRV. `blake3` jest przypięty do 1.8.2 w `Cargo.lock` (nowsze wersje wymagają edition 2024). Po `cargo update` przypnij go ponownie: `cargo update -p blake3 --precise 1.8.2`.

```bash
yarn install
anchor build
anchor test                                   # lokalny walidator, 19 testów
cargo test -p pacta                           # testy jednostkowe podziału
anchor deploy --provider.cluster "$PACTA_RPC_URL"   # URL z kluczem, np. Alchemy devnet
```

**RPC.** URL z kluczem API trzymamy poza repo (zmienna środowiskowa), nie w `Anchor.toml`. Anchor przyjmuje go flagą `--provider.cluster <url>`, a skrypty zmienną `ANCHOR_PROVIDER_URL`. Alchemy nie obsługuje subskrypcji websocket (`signatureSubscribe`), dlatego skrypty potwierdzają transakcje pollingiem (`PollingConnection` w [`scripts/common.ts`](scripts/common.ts)). Frontend musi zrobić to samo albo ustawić `wsEndpoint` na RPC, które websockety wspiera. Airdrop (`requestAirdrop`) przez Alchemy devnet działa, publiczny faucet bywa zablokowany (429).

## Demo na devnecie

```bash
yarn demo:setup              # .keys/: client, backend-dev, frontend-dev, designer, arbiter, usdc-mint
                             # SOL (faucet z retry, potem fallback z portfela deployera), mint 10 000 USDC dla klienta, ATA dla wszystkich
yarn demo:flow create        # projekt + milestone 1 000 USDC, podział 40/35/25
yarn demo:flow agree         # trzy podpisy -> Active
yarn demo:flow fund          # 1 000 USDC do vaultu
yarn demo:flow submit        # backend-dev: start + submit
yarn demo:flow accept        # klient akceptuje -> 400 / 350 / 250 w jednej transakcji
yarn demo:flow status        # salda, statusy, komendy fixture dla backendu
```

Każdy krok wypisuje link do transakcji w Explorerze. Publiczne RPC devnetu odpowiada 429 przy wielu zapytaniach z jednego IP, więc przed uruchomieniem ustaw `export ANCHOR_PROVIDER_URL="$PACTA_RPC_URL"`.

Klient ma po pierwszym przebiegu 9 000 USDC, więc `create → accept` można powtórzyć na żywo wielokrotnie (każdy `create` tworzy nowy projekt z nowym seedem).

### Portfele do testów w przeglądarce

Każdy portfel, który podpisuje transakcje (klient, członek zespołu, arbiter), potrzebuje trochę SOL na opłaty. Klient potrzebuje też testowego USDC. Oba zasila deployer: płaci SOL i jako jedyny może dodrukować USDC.

```bash
yarn wallet new anna --usdc 1000      # .keys/anna.json + 0,1 SOL + 1 000 USDC, wypisuje klucz do importu w Phantomie
yarn wallet new jan                   # członek zespołu albo arbiter: samo 0,1 SOL
yarn wallet fund <adres> --usdc 500   # doładuj dowolny portfel, np. utworzony w Phantomie (SOL dobijane do 0,1)
yarn wallet fund anna --sol 0.5       # zamiast adresu można podać nazwę z .keys/
yarn wallet key client                # klucz istniejącego portfela z .keys/ do importu w Phantomie
yarn wallet list                      # wszystkie portfele z .keys/ z saldami SOL i USDC
```

`--sol` dobija saldo do podanej kwoty (domyślnie 0,1), `--usdc` dodrukowuje podaną liczbę tokenów. Wypisany klucz wklejasz w Phantomie: Add / Connect Wallet → Import Private Key, sieć Devnet.

`.keys/` jest w `.gitignore`. Nie commitujemy keypairów.
