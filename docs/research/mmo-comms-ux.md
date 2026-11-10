# MMO communication & coordination UX → a Folie TUI for operating an agent swarm

Date: 2026-11-08. Scope: research brief only, no code changes.
Convention: claims carry an inline source URL. `[INFERENCE]` = my reasoning, not stated by a source. `[UNVERIFIED]` = recalled/plausible but I did not fetch a primary source. Section 7.3 lists evidence gaps.

Folie today (from the assignment + `src/tui/model.ts`, `src/tui/commands.ts`): fleet table, message stream, `:` command line; views `stream inbox topics reports inspector alerts budgets`; alert kinds `verification_rejected budget_exhausted stall approval_expiring execution_lost policy_denied stale_fence_conflict undelivered_publication`; commands `submit send publish subscribe unsubscribe suspend resume delete cancel view quit`. Backend: goals (work items), agents, topics, messages, tasks (claims/fences/leases), verifications, budgets, ledger events, sessions+transcripts, control signals (cancel/pause).

---

## 1. Executive summary

- **Hierarchy + delegation is what makes hundreds tractable, not better chat.** EVE caps a fleet at 256 (5 wings × 5 squads × ~10) and tells the FC to delegate so he "sets his mind to other matters" ([Fleet Command Guide](https://wiki.eveuniversity.org/Fleet_Command_Guide), [Fleet leadership — deprecated article, structure still matches current 1–256 max-size option](https://wiki.eveuniversity.org/Fleet_leadership)). Folie's human should command ~3–5 leads, not 20+ workers.
- **Broadcasts are a closed vocabulary with audience scope.** EVE's fleet broadcasts are ~8 typed buttons (Need Armor/Shield/Capacitor/Backup, In Position, Hold Position, Location, Enemy Spotted) routed to *my group / everyone / superiors*, filterable per receiver, colour-coded in a history tab ([Fleet interface](https://wiki.eveuniversity.org/Fleet_interface)). Folie's agent-state signals should be a small typed taxonomy, not free text.
- **Filtering beats volume.** "Your biggest enemy is having too much information thrown at you; being able to filter it can give you a decided advantage" ([Fleet Command Guide](https://wiki.eveuniversity.org/Fleet_Command_Guide)). EVE's Overview = presets × tabs × ordered colour rules, shareable as files ([Overview settings](https://wiki.eveuniversity.org/Overview_settings)). Folie needs saved, shareable *views*, not more screens.
- **Cheap repeatable scans replace reading logs.** D-scan returns only name+type, is range/angle-scoped, preset-filtered, rerun every few seconds, and pasteable to a parser ([Directional scanning](https://wiki.eveuniversity.org/Directional_scanning)). Folie's inspector should be a one-key "scan" of an agent/goal, not a transcript viewer.
- **Brevity and discipline are protocol, not etiquette.** "Break break", "Brevity!", 6–7-word commands, channel prefixes, typed mirror of voice orders ([Voice procedure](https://wiki.eveuniversity.org/Voice_procedure), [Brevity codes](https://wiki.eveuniversity.org/Brevity_codes), [Fleet Command Guide](https://wiki.eveuniversity.org/Fleet_Command_Guide)). Folie commands and agent reports need a fixed grammar and size budget.
- **Pings (one-key, contextual, logged) beat typed messages under load** — in both Dota and LoL research ([Wuertz et al., CHI'17](http://library.usc.edu.ph/ACM/CHI%202017/1proc/p1978.pdf), [Lee et al., CHI'25](https://arxiv.org/pdf/2502.17935)). Folie needs human→agent and agent→human pings bound to entities.
- **Attention is a budget; every system studied shows notification fatigue** when tiers are abused (`@everyone`, alarm fatigue, DPS shown tank-buster timers) ([WHSOC ping etiquette](https://whsoc.fandom.com/wiki/Discord_Ping_Etiquette), [Icy Veins on Blizzard boss timeline](https://www.icy-veins.com/wow/news/blizzards-boss-timeline-still-cant-replace-dbm-creator-shows-why), [BMC Nursing review](https://link.springer.com/article/10.1186/s12912-025-03369-2)). Design the *attention queue* first; everything else is secondary.
- **Silent filter holes are deadly.** Stale EVE overviews silently omit new entity types; colour-rule order can hide a war target behind a bounty skull ([Overview](https://wiki.eveuniversity.org/Overview), [Overview settings](https://wiki.eveuniversity.org/Overview_settings)). Folie filters must fail open for unknown kinds and always show a "N hidden" counter. [INFERENCE on counter]
- **Roles ≠ titles; authority is auditable.** EVE corp roles define what you *can do*, titles bundle roles, role changes are audit-logged ([Managing corporation members](https://wiki.eveuniversity.org/Managing_corporation_members)). Maps cleanly to agent capability grants + ledger.
- **Mission command is the military analog:** commander's intent + mission orders + disciplined initiative ([ADP 6-0 summary](https://armyadp.com/publications/adp-6-0/mission-command-principles)). Folie goals should carry intent/ROE and let leads act inside them, escalating by exception.

---

## 2. Per-game breakdown

### 2.1 EVE Online (primary case)

**Communication channels**
- *Local* — auto-populated list of every pilot in the system in known space; present even if docked or cloaked; blank in wormholes/Pochven unless someone speaks ([Scouting § Local](https://wiki.eveuniversity.org/Scouting)). The count in the header is itself intel ("seven in Local"). Presence-as-ambient-channel.
- *Fleet chat* with typed mirror of voice commands: one pilot per squad (ideally not the SC) types leadership's verbal orders "as insurance against audio issues… builds a written record" ([Fleet Command Guide § Typed commands](https://wiki.eveuniversity.org/Fleet_Command_Guide)).
- *Voice* (Discord/Mumble) with a separate **Command channel** for FC/WCs/scouts; line members mostly silent in larger fleets ("combat comms") ([Voice procedure](https://wiki.eveuniversity.org/Voice_procedure), [Rookie's Guide § Voice Comms](https://wiki.eveuniversity.org/The_Rookie%27s_Guide_to_Fleet_Ops)). Message form `<Receiving channel>, <Transmitting pilot>: <message>`.
- *Corp / alliance chat*, MOTD per channel (Communications Officer role edits corp MOTD) ([Managing corporation members](https://wiki.eveuniversity.org/Managing_corporation_members)). Opsec rule: don't ask in Corp/Alliance about active fleets ([Rookie's Guide § Operational security](https://wiki.eveuniversity.org/The_Rookie%27s_Guide_to_Fleet_Ops)).
- *Intel channels* (alliance-run): strict post format (see below).
- *Out-of-game*: Discord with opt-in **ping channels**, `@here` vs `@everyone`, follow-ups moved to a thread attached to the ping, a built-in ping tool with form-up time/location/doctrine fields ([EVE Uni Discord](http://wiki.eveuniversity.org/Discord)). Jabber/bridges: [UNVERIFIED] — I found community Discord bots (e.g. [PingBot](https://github.com/Ionaru/PingBot), [ThunderED](https://github.com/panthernet/ThunderED)) but no primary source on Jabber bridging.
- *Mail, notifications, market/contracts as async comms*: [UNVERIFIED] as comms mechanisms. Only grounded fact: corp roles gate Contract Manager/Trader/Accountant actions and the corp calendar exists for scheduled fleets ([Managing corporation members](https://wiki.eveuniversity.org/Managing_corporation_members), [Rookie's Guide § Forming up](https://wiki.eveuniversity.org/The_Rookie%27s_Guide_to_Fleet_Ops)). [INFERENCE] Contracts/market are best understood as asynchronous, auditable, ACL-gated handoffs — which is exactly Folie's task claim/submit flow.

**Coordination primitives**
- **Fleet → Wings (≤5) → Squads (≤5) → members**; FC, WC, SC. A separate **Fleet Boss** role is purely administrative (promotions to WC/FC, MOTD, advert); the FC decides, the boss administers ([Fleet leadership](https://wiki.eveuniversity.org/Fleet_leadership)). *Chain of command*: FC, 2IC, 3IC "if the fleet is large", scouts, specialist leaders (logi FC, EWAR FC) ([Fleet Command Guide § Chain of Command](https://wiki.eveuniversity.org/Fleet_Command_Guide)). "Protecting command": backup commanders, don't command from the pod.
- **Fleet window**: hierarchy vs flat view, History tab to watch broadcasts, store/load fleet setups, free-move toggle, max size, regroup, "accept fleet warps" opt-out for scouts ([Fleet interface](https://wiki.eveuniversity.org/Fleet_interface)).
- **Fleet Composition window** (command roles only; sees only subordinates): name, location, ship type, ship group, fleet role, leadership skills, position ([Fleet interface § Fleet composition](https://wiki.eveuniversity.org/Fleet_interface)).
- **Broadcasts** (see §2.1 table below) and **Tags**: only command-role members may tag an object with a letter/number visible in the overview Tag column; tags die with the target ([Overview § Tagging](https://wiki.eveuniversity.org/Overview)).
- **Primary/Secondary/Tertiary** target calls so pilots pre-lock; "more important than any function of the Fleet Commander" ([Fleet Command Guide](https://wiki.eveuniversity.org/Fleet_Command_Guide)).
- **Brevity codes / standing orders**: Jump On Contact / Hold On Contact, Hold Cloak (default after a jump unless ordered otherwise), Scatter, Bugout, Marshal, Resume, Reset, New Picture ("supersedes all previous calls"), Roger/Wilco/Unable, `Weapons FREE/TIGHT/HOLD` (rules of engagement), Alpha one/two/three damage status ([Brevity codes](https://wiki.eveuniversity.org/Brevity_codes), [Rookie's Guide § Manoeuvres](https://wiki.eveuniversity.org/The_Rookie%27s_Guide_to_Fleet_Ops)). "See Flashy, Shoot Flashy" = ROE that lets members act without per-target orders.
- **X-up** for role signup ("x logi Inquisitor"), "wait until the FC calls your role, don't spam"; **Fleet Finder/advert** with scope (corp/alliance/standings), approval flag, range; join requests approved only by FC/Boss ([Rookie's Guide § Forming up](https://wiki.eveuniversity.org/The_Rookie%27s_Guide_to_Fleet_Ops), [Fleet interface § Fleet advert](https://wiki.eveuniversity.org/Fleet_interface)).
- **Watchlist**: ≤100 pilots; FC/WC/SC/scouts by default; used to warp-to and for logi to see who needs reps; "Add Squad Members to Watch List" ([Fleet interface § Fleet Watch Lists](https://wiki.eveuniversity.org/Fleet_interface)).
- **Scouts as information roles**: pickets, +1/−1 (one jump ahead/behind), roaming hunters; `+n` and `-1` are *positions* in the formation of intel ([Scouting](https://wiki.eveuniversity.org/Scouting), [Brevity codes](https://wiki.eveuniversity.org/Brevity_codes)). Roaming scouts "report less detailed information… to avoid information overload"; an empty transit system isn't worth reporting.
- **Command bursts/boosters**: boosts flow down the hierarchy but a position held by an unskilled pilot *blocks* them; booster position can be assigned to anyone below ([Fleet leadership](https://wiki.eveuniversity.org/Fleet_leadership), deprecated page). [INFERENCE] analogue: shared context/tooling provided by a lead to a subtree, and a mis-configured lead silently starving its subtree.

**EVE broadcasts (verified list)** — [Fleet interface § Broadcasting](https://wiki.eveuniversity.org/Fleet_interface)

| Button | Scope | Meaning |
|---|---|---|
| Enemy Spotted | whole fleet | contact |
| Need Armour / Shield / Capacitor | on-grid fleetmates | repair request, routed to the role that can serve it |
| In Position | whole fleet | assigned task/place reached |
| Need Backup | whole fleet | under attack, want help |
| Hold Position | whole fleet | stay put |
| Location | whole fleet | puts my location on the list; recipients get a right-click action menu |
| Audience selector | *My group* (subordinates) / *Everyone* / *Superiors* (direct chain only) | |

Receivers choose which kinds to see (e.g. mute "Need Armor" if not logi) and set a background colour per kind; History tab filters: All / Broadcast / Member / Loot. A Misc overview option moves objects named in broadcasts to the top of the overview ([Overview settings § Misc](https://wiki.eveuniversity.org/Overview_settings)).

**Information-density tricks**
- Overview: 5-pass model (types shown → state exceptions → ordered colour-tag → ordered background → tabs bound to presets, up to 8 tabs); column chooser; **overview freezes while a shortcut key is held** so rows don't reshuffle under the cursor; new rows append at bottom, vanished rows fade ([Overview](https://wiki.eveuniversity.org/Overview), [Overview settings](https://wiki.eveuniversity.org/Overview_settings)).
- Separate **bracket filters** (what is drawn in space) from **overview filters**; turn brackets off in 100s-pilot fights because of server-side lag ([Overview § Filtering](https://wiki.eveuniversity.org/Overview)). [INFERENCE] a render/poll budget separate from the information filter.
- FC presets: Filter 1 battleships, 2 battlecruisers/EWAR recons, 3 everything else, 4 wrecks ("tally Friendly vs Unfriendly losses") ([Fleet Command Guide § Battle oversight](https://wiki.eveuniversity.org/Fleet_Command_Guide)).
- Overview packs: communities standardise on one pack "so you can follow and issue commands or intel with the knowledge that the other person… has the same overview" ([Overview § Overview pack](https://wiki.eveuniversity.org/Overview)). Shared *vocabulary of visibility*.
- Standing/colour: blue/red/flashing "red flashy" = war target/outlaw backgrounds; chosen so that default quiet, hostile loud ([Overview settings § Background](https://wiki.eveuniversity.org/Overview_settings)). Only flashing for what must interrupt.
- Intel post format: **Who / Where / What / How many / Activity / D-scan link**; shorthand `NV` (no visual), `Clr`, `+n`, `spike`; one short line per post; paste-parsers (dscan.info, localthreat) turn raw scans into summaries ([Horde-Reporting Intel](https://wiki.eveuniversity.org/Horde-Reporting_Intel), [Scouting § Paste services](https://wiki.eveuniversity.org/Scouting)).
- D-scan as above: name+type only, 5°–360° cone, up to 14.3 AU, 2 s cooldown, preset filter, "spam to danger level" (every 8–10 s in a wormhole, ~1 min in 0.9 space) ([Directional scanning](https://wiki.eveuniversity.org/Directional_scanning)). *Scan cadence is a function of risk.*
- Killmail: victim, time/place, every contributor with damage, final blow and top damage highlighted, fit, value, drops; saved in a per-character combat log; draggable as a link into chat ([Killmail](https://wiki.eveuniversity.org/Killmail)). Fleet window also keeps Member history (roles, leaves) for After Action Reports ([Fleet interface § Broadcast](https://wiki.eveuniversity.org/Fleet_interface)).

**What makes hundreds tractable (EVE)**
1. Recursive delegation with *scoped visibility* (composition window shows only subordinates) — [Fleet interface](https://wiki.eveuniversity.org/Fleet_interface).
2. Silence by default; speech only for contact reports and command ([Voice procedure](https://wiki.eveuniversity.org/Voice_procedure), [Rookie's Guide](https://wiki.eveuniversity.org/The_Rookie%27s_Guide_to_Fleet_Ops)).
3. Pre-agreed doctrines/standing orders so most behaviour needs no message ("default order after a gate jump is hold cloak"; "usually a standing order to save yourself when taking heavy damage") — [Rookie's Guide § Manoeuvres](https://wiki.eveuniversity.org/The_Rookie%27s_Guide_to_Fleet_Ops).
4. Forward scouts and pickets supply the picture so the FC doesn't scan.
5. Group actions (fleet warp, regroup, formations, scatter) so one command moves everyone; opt-out flags for specialists ([Fleet interface](https://wiki.eveuniversity.org/Fleet_interface)).
6. Deterministic spreading rules when no order exists ("pick a target whose character name starts with the same letter as yours") — decentralised load-spreading ([Rookie's Guide § Rookie tackler tips](https://wiki.eveuniversity.org/The_Rookie%27s_Guide_to_Fleet_Ops)). [INFERENCE] analogue: claim sharding when many agents see the same queue.

**Corp roles / ACL.** ~14 general roles (Accountant, Auditor, Communications Officer, Contract Manager, Diplomat, Director, Personnel Manager, Station Manager, Trader…), per-division wallet/hangar *query* vs *take* roles, "grantable roles" (may grant others), Director = all roles but CEO-only grant, titles = named bundles + vanity text, auditing tab logs every role change; roles must be dropped 24 h before expulsion ([Managing corporation members](https://wiki.eveuniversity.org/Managing_corporation_members)). Warning in the page: Rent Office needs no wallet access — a single role can burn the wallet; grant carefully.

### 2.2 Warframe
- **Channels by scope**: Squad (≤4, [Squad](https://wiki.warframe.com/w/Squad)), Relay/hub instance, Clan, Alliance, Region, Q&A, Recruiting, Trade, Council, plus whispers and a private "Notes" tab that persists locally ([Chat](https://wiki.warframe.com/w/Chat)).
- **Slash commands switch channel *and* optionally send**: `/s /c /g /r /w user msg`, `/dnd` (auto-response "contact me later"), `/invite /join`, `@user` links+pings, `where item` / `when event` bot queries ([Chat § Commands](https://wiki.warframe.com/w/Chat)). Prefix-per-scope is the same idea as EVE's voice `Squad 1:` prefix.
- **Per-channel inclusive/exclusive keyword filters** for the noisy public channels, applied only to *new* messages ([Chat § Filtering](https://wiki.warframe.com/w/Chat)).
- **Clan hierarchy**: 8 ranks that "are not strictly seniority… but a set of privileges"; 12 roles (Ruler, Recruiter, Regulator, Promotion, Architect, Treasurer, Tech, Tactician, Chat Moderator, Herald (MOTD), …); promote only up to your own role; tiers cap membership at 10/30/100/300/1000 and alliances at 4000 ([Clan](https://wiki.warframe.com/w/Clan)).
- Tractability trick: *squads are small (4)*, large scale lives in async clan/alliance structures (vault, research) not live coordination. [INFERENCE]

### 2.3 World of Warcraft (raid)
- **Target markers**: 8 icons, one per unit and one unit per icon, visible to the group; in a raid only leader/assistants may set them; also a `/tm N` command; the set API became *protected* (secure-code only) in patch 12.0.0 ([SetRaidTarget](https://warcraft.wiki.gg/wiki/API_SetRaidTarget)). Scarcity of 8 markers forces prioritisation. [INFERENCE: rationale for protection not stated]
- **Leader vs assistants** is the authority split ("raid leader and the assistants"), same shape as EVE boss/FC/WC ([SetRaidTarget](https://warcraft.wiki.gg/wiki/API_SetRaidTarget)).
- **Boss-mod timers/alerts**: DBM/BigWigs give timers for upcoming mechanics, four warning types (general, AoE, "airhorn" must-act-or-die, run-away), and range checks ([DBM guide](https://www.warcrafttavern.com/wow/guides/dbm-guide)). Blizzard's built-in boss timeline (Midnight) lacks per-ability toggles (DPS see tank-buster timers = overload), has wrong/missing timers on some bosses, ignores two of three warning levels; addons stay mandatory ([Icy Veins, 2026-07](https://www.icy-veins.com/wow/news/blizzards-boss-timeline-still-cant-replace-dbm-creator-shows-why)).
- Raid frames, healer-click-casting, ready checks/pull timers: [UNVERIFIED] — I did not fetch Blizzard primary docs. Search surfaced addon panels with ready check/pull timer ([RMP](https://www.curseforge.com/wow/addons/rmp-raid-markers-panel)) but I don't rely on them. [INFERENCE] The raid frame pattern is one fixed-size cell per member showing only health/aggro/debuff glyphs, arranged by group.

### 2.4 Final Fantasy XIV
- **Party list** pinned top-left shows vital stats of all members, click to target; hidden when solo (option) ([Game Manual: Navigating the Game Screen](https://na.finalfantasyxiv.com/game_manual/view)).
- **Log tabs**: General (chat), Battle (messages; "fly text" on-screen cues remove the need to read it in combat; used for post-battle analysis), Event ([same](https://na.finalfantasyxiv.com/game_manual/view)). Real-time info → glyphs; text → retained for review.
- **Signs** (target markers above players/enemies, e.g. kill order) and **Waymarks** (ground markers placed from the Party menu, hotbar-bindable, clearable, savable); waymarks **cannot be placed once combat has begun** (except PvP) ([Signs](https://na.finalfantasyxiv.com/uiguide/battle/battle-target/targetmarker_about.html), [Using Waymarks](https://na.finalfantasyxiv.com/uiguide/battle/battle-target/fieldmarker_how.html)).
- **Aggro lines**: yellow lines linking enemies that will attack together ([Aggro Lines](https://na.finalfantasyxiv.com/uiguide/battle/battle-target/target_linkline.html)) — *relationships drawn, not described*.
- Hotbars accept actions, emotes, macros, *and target markers* — comms primitives are first-class hotkeyable actions ([Game Manual](https://na.finalfantasyxiv.com/game_manual/view)).
- Cross-world party finder, linkshells, free company chat: [UNVERIFIED] beyond a patch-notes mention of cross-world party recruitment.

### 2.5 Discord (as the real-world comms layer for guilds)
- Notification levels per server and per channel (**All / Mentions / Nothing / Mute**), suppress `@everyone`/`@here`/role mentions, mute-with-duration; `@everyone` still pierces a server mute unless suppressed ([Notifications Settings 101](https://support.discord.com/hc/en-us/articles/215253258-Notifications-Settings-101)).
- Roles + per-channel permission overrides ([Permissions](https://docs.discord.com/developers/topics/permissions)).
- Guild conventions on top: opt-in ping channels, soft ping vs `@here` vs `@everyone` severity ladder, "DO NOT CHAT in ping channels", info-rich ping so people don't ask 10 times ([WHSOC](https://whsoc.fandom.com/wiki/Discord_Ping_Etiquette), [EVE Uni](http://wiki.eveuniversity.org/Discord)), forum channels with tags + close/lock for buy/sell ([EVE Uni](http://wiki.eveuniversity.org/Discord)). Threads, forum channels, stage channels details: [UNVERIFIED] beyond the EVE Uni description.

### 2.6 Minecraft
Not researched to primary-source depth. [UNVERIFIED] Commonly `/msg`, coordinates in chat, command blocks and scoreboards as automation/status surfaces. Not used for any design decision below.

### 2.7 Dota 2 / League of Legends ping systems
- Dota: 756 gesture events in 8 replays, 729 pings vs 27 annotations; six intents: planning 37.2%, warning 37%, resource 8%, conflict 8.7%, help 1%, emoting 8.1%; warnings peak just before mid-game and planning just after; survey of 167: pings, text chat, chat wheel judged helpful for winning, annotations least; pings could be improved by conveying intent and reducing ambiguity ([Wuertz et al. CHI'17](http://library.usc.edu.ph/ACM/CHI%202017/1proc/p1978.pdf)).
- LoL (22 players observed in ranked): pings via wheel/hotkey, 8 "smart" pings (Retreat, On My Way, Assist Me…); **most pings are logged in chat** so all comms land in one textual channel; pings carried "context over the game" in the structured phase ("Enemy Missing"); players prefer pings for non-critical info but *type* what is too important to be missed; communication cost (time/action economy) drives medium choice; players read *frequent communication as a precursor to team breakdown*, and valued commitment shown by action; "Enemy Missing" pings were also used to blame teammates ([Lee et al. CHI'25](https://arxiv.org/pdf/2502.17935)). Heroes of the Storm ping frequency had a concave relationship to performance — helpful then distracting (cited therein).
- Riot design post on ping context: not retrievable (fetch returned a landing page), so not used.

### 2.8 StarCraft control groups
- Ctrl+0–9 assigns the selection to a group, number recalls, Shift+number adds; 10 groups; bind same-type buildings together to act on them as one (e.g. select-all-larva across hatcheries); Tab cycles types inside a group; F1 idle workers, F2 all army; Backspace cycles bases; camera-location hotkeys ([Tictac Tactics guide](https://tictactactics.wordpress.com/2015/07/18/the-beginners-guide-to-starcraft-2-part-ii-hotkeys)). Liquipedia pages were 403; secondary source only.
- Key idea: *humans operate 100+ units by naming a handful of groups and an "idle things" shortcut.*

### 2.9 Military C2 analogs (brief)
- ADP 6-0 mission command: decentralized execution, commander's intent as end state, disciplined initiative "in the absence of orders… or when existing orders no longer fit", mission orders say *what not how*, mutual trust, shared understanding, prudent risk ([ADP 6-0 summary site](https://armyadp.com/publications/adp-6-0/mission-command-principles); primary PDF at [armypubs](https://armypubs.army.mil/epubs/DR_pubs/DR_a/ARN47032-ADP_6-0-000-WEB-1.pdf) not read — the summary site is secondary).
- EVE already imports the voice side: proword/phonetics procedure ([Voice procedure](https://wiki.eveuniversity.org/Voice_procedure)), brevity codes, picture/status/new-picture calls ([Brevity codes](https://wiki.eveuniversity.org/Brevity_codes)).

---

## 3. Cross-cutting core features (what helps a human coordinate many actors)

Each: **what / why easier / Folie mapping**. `new` = needs backend support beyond what the assignment lists [INFERENCE: I did not audit the backend for hierarchy fields].

1. **Hierarchical roster with role + position.** Fleet window in hierarchy view; FFXIV party list; WoW raid groups. *Why:* span of control is bounded; the human scans 3–5 headers, expands on demand. *Folie:* roster rows grouped Fleet → Wing (lead agent) → Squad (workers on one goal); `new`: `wing`/`squad`/`role` attributes on agents; default derivation: group = root goal.
2. **Scoped authority and visibility.** Fleet composition shows only subordinates; broadcasts to "my group/superiors". *Why:* each commander sees a tractable slice. *Folie:* leads see own subtree; the human sees leads + exceptions; message routing respects subtree.
3. **Typed broadcasts with audience scope and per-receiver subscriptions.** *Why:* a closed vocabulary is scannable and filterable ("mute Need Armor if not logi"). *Folie:* broadcast = a typed message kind with `scope ∈ {group, all, superiors}`; kinds in §6.4; each recipient role subscribes to kinds; rendered one line per broadcast in a History panel with per-kind colour/glyph. `new`: message `kind` + `scope`.
4. **Standing orders, brevity codes and ROE.** `Weapons FREE/TIGHT/HOLD`, "See flashy shoot flashy", hold-cloak default. *Why:* removes per-action messages; commander's intent substitutes for micromanagement ([ADP 6-0](https://armyadp.com/publications/adp-6-0/mission-command-principles)). *Folie:* per-goal/wing **ROE level** (HOLD = propose only; TIGHT = act on claimed tasks within budget; FREE = may spawn/claim); defaults that apply when nothing is ordered (e.g. on stall: checkpoint+report). Maps to budgets, claims, policy.
5. **Primary/Secondary/Tertiary + tags.** *Why:* everyone pre-positions on next target; limited slots force prioritisation (WoW 8 markers; EVE tags command-only). *Folie:* priority tags on goals/tasks (`P`, `S`, `T`, plus ≤8 symbolic marks); only human/leads may tag; tag cleared on done/failed; priority drives roster sort and claim order.
6. **Watchlist.** ≤100 pins, default FC/WC/SC/scouts, add whole squad. *Why:* a fixed always-visible cell for the few things you must see. *Folie:* pinned agents/goals with 2-line mini-cards (state, current task, last report age, burn); `:watch @a1`; auto-pin leads.
7. **Overview presets/tabs/filters with ordered colour rules and freeze-on-act.** *Why:* one screen serves many situations; rows don't move under your cursor; shared packs create shared vocabulary. *Folie:* saved *views* = filter × columns × sort × colour-rule order (bound to keys 1–8); export/import YAML; "freeze" while a selection/modifier/input is active; always-on "hidden: N" counters; unknown kinds fail open.
8. **Cheap repeatable scan (d-scan).** *Why:* no commitment, name+type only, scoped by cone, repeatable at risk-dependent cadence, results pasteable. *Folie:* `scan` on agent/goal/wing → ~6 lines: state, claimed task+lease remaining, last tool call, tokens/$ this session, last verification, last message; cone = scope (agent / goal subtree / topic) + window (last N minutes); `scan --every 10s` while a risky goal runs; output is copy-linkable into a message.
9. **Intel-report format.** Who/Where/What/How many/Status + evidence link, with positive "Clr" and "NV". *Why:* parsable, short, and *absence* is reported. *Folie:* agent report schema: `agent · goal/task · state · evidence link (session/ledger id) · confidence?`; explicit "clear" heartbeat for watched goals; no free-text prose in broadcasts.
10. **Ambient presence (Local).** *Why:* "is anyone else here?" answered without asking. *Folie:* per-goal/topic presence strip (who is in this "system"), glyph per agent in a minimap row; "spike" = sudden agent count change.
11. **Control groups + idle-selector + cycle keys.** *Why:* 10 numbers address everything; F1-style jump finds neglected units. *Folie:* `Ctrl+1..9` binds current selection (agents/goals), `1..9` recalls (multi-select), `Shift+n` adds; `i` = next idle agent; `.`/`,` = next/prev attention item; `Tab` cycles inside a group.
12. **Contextual pings, logged as text.** *Why:* one keystroke, entity-bound, low cost; LoL logs them into chat so history stays unified ([Lee et al.](https://arxiv.org/pdf/2502.17935)). *Folie:* human→agent pings (`look`, `status?`, `hold`, `go`), agent→human pings (`need-X`); each ping is a typed message row in the stream, deduped per entity.
13. **Anticipatory timers with severity tiers.** DBM timers + 4 warning types; per-role filtering. *Why:* converts reactive alarms into plans; filtering avoids overload; inaccurate timers destroy trust ([Icy Veins](https://www.icy-veins.com/wow/news/blizzards-boss-timeline-still-cant-replace-dbm-creator-shows-why)). *Folie:* countdown rows for lease expiry, `approval_expiring`, budget burn-rate-to-zero, verification deadline; 3 tiers (`info`, `warn`, `must-act`) with only `must-act` allowed to interrupt/bell; timers show their basis (e.g. "est. from last 10 min burn").
14. **After-action record (killmail / combat log / member history).** *Why:* learning loop and accountability; links to single artifacts. *Folie:* per-goal "killmail": goal, outcome, contributors (agents, tasks), $/tokens, retries, verification verdicts, ledger event span; draggable/linkable id (`#goal-42`); fleet History tab = ledger filtered to membership/role/claim changes.
15. **Channels by scope + opt-in ping channels + thread-per-ping.** *Why:* urgency is encoded by where it appears, not by words. *Folie:* topics as channels (`#wing-alpha`, `#goal-42`), an `#announce` channel that is read-only, discussion in the attached thread; human subscription levels All/Mentions/Nothing/Mute per topic (mirrors [Discord](https://support.discord.com/hc/en-us/articles/215253258-Notifications-Settings-101)).
16. **Roles vs titles + audit.** *Why:* least privilege, bundles for convenience, change history. *Folie:* capability roles (`claim`, `propose`, `spawn`, `spend>$N`, `publish:#topic`, `cancel:subtree`) bundled into titles (`lead`, `worker`, `reviewer`, `scout`); role changes are ledger events; `grantable` roles for leads.
17. **Group actions (regroup, scatter, bugout, formations).** *Why:* one order moves everyone; opt-out flags for specialists. *Folie:* `/regroup` = all agents in scope checkpoint + report state; `/scatter` = pause all in scope (control signal); `/bugout` = cancel with save; per-agent `accept-fleet-orders` off for e.g. a long-running scout.
18. **Stored fleet setups and x-up.** *Why:* reproducible teams. *Folie:* `/fleet save <name>` / `/fleet load` templates (wings, roles, ROE); agents may `x-up` for a role (capability offer) which a lead accepts — fits claim flow.
19. **Command discipline: short orders, typed record, silence default.** *Folie:* every human command is echoed into the stream as a durable order row (the "typed mirror"); command grammar capped at ~7 tokens; agent chatter between workers is not shown to the human unless escalated.
20. **Do-not-disturb / focus mode.** Warframe `/dnd` auto-response ([Chat](https://wiki.warframe.com/w/Chat)); Discord mute/suppress. *Folie:* `/dnd [dur]` suppresses everything below `must-act`, queues the rest as a digest, tells leads "human away; escalate only X".

---

## 4. Mental-model mapping table

| MMO concept | Folie concept | Proposed UI element |
|---|---|---|
| Fleet (all members) | Swarm / run scope | Header: swarm name, counts by state, burn, `alerts N` |
| Fleet Commander + Fleet Boss | The human operator (decide + administer) | Operator identity in header; `boss` actions (promote, budgets) separate from `fc` actions (orders) |
| Wing Commander | Lead agent owning a goal subtree | Wing header row with summary glyphs of its squads |
| Squad / Squad Commander | Workers on one goal / sub-lead | Collapsible group rows |
| 2IC / 3IC | Backup lead (hot standby) | `succession:` field on wing; auto-promote on `execution_lost` |
| Scout (+1/−1, picket) | Recon/research agent (reads ahead; watches a goal) | Role glyph; reports in intel format |
| Logistics ("Need Armor") | Verifier/reviewer agent ("need-review") | Broadcast routing: need-review → reviewers |
| Booster / command burst | Shared context/tools/policy a lead pushes down | `boost:` tag on wing (skills/context pack) |
| Fleet composition window | Roster table (name, goal, task, role, state, last-heard, burn) | Main roster, scoped to my subtree |
| Fleet Watchlist | Pinned agents/goals | Right-side watchlist cards |
| Local chat member list | Presence per topic/goal | Presence strip + minimap row |
| Overview + tabs + presets | Saved views | Tabs 1–8; `:view save/load/share` |
| Colour tags / backgrounds / flashing | Severity + state encoding | Ordered rule list; flash only `must-act`; words+glyph, never colour alone (matches existing `alertsLines` principle) |
| Bracket filter vs overview filter | Detail level vs filter | Density toggle (`d`) separate from filters |
| Overview freeze while key held | Don't reorder under cursor | Freeze flag while selection/modifier/input active |
| Tags (primary/secondary) | Goal/task priority marks | `P/S/T` + 8 marks on rows |
| Broadcast + History tab | Typed agent-state signal + feed | Broadcast panel (one line each), per-kind subscribe/colour |
| D-scan | Inspector "scan" | `s` key / `/scan`; preset filters; result linkable |
| Intel channel (Who/Where/What/N/Status) | Agent report schema | Report row template; `Clr`/`NV` equivalents |
| Brevity codes (JOC/HOC, Scatter, Bugout, Resume) | Command verbs + standing orders | Slash command set §6.2; `:help` lists them |
| Weapons FREE/TIGHT/HOLD | Autonomy / ROE level | `roe:` per wing/goal; shown as glyph |
| Voice procedure `Squad 1:` prefix | Address prefix | `@agent`, `@wing`, `@all`, `#topic` prefixes |
| Typed mirror of voice orders | Order echo in stream | Order rows with ack state |
| Roger / Wilco / Unable | Ack states of an order | `ack`/`will-comply`/`unable(reason)` badges |
| X-up | Agent capability offer | `x` entries in a signup list for a goal |
| Fleet advert / Finder | Open goal/role listing | `topics`-like board of open roles |
| Corp roles / titles / audit | Capability roles / titles / ledger | Role editor + audit view (ledger filter) |
| Killmail / combat log | Goal outcome record | `reports` view: one card per goal, linkable id |
| Fleet Member history / loot history | Ledger filtered to membership/claims/costs | History tab modes |
| Regroup / Scatter / Bugout | Checkpoint-all / pause-all / cancel-with-save | `/regroup /scatter /bugout` |
| Control group (SC) | Selection binding | `Ctrl+n` / `n` |
| F1 idle workers | Next idle agent | `i` |
| Ping (LoL/Dota) | Entity-bound one-key signal | Ping menu `p` on focused row |
| Boss timers/airhorn | Anticipatory timers + must-act tier | Timer strip; bell only on `must-act` |
| `/dnd` | Human focus mode | `/dnd` |
| Discord ping channel + thread | Announce topic + thread | `#announce` read-only + reply threads |

---

## 5. Anti-patterns and failure modes (with sources)

1. **Comms saturation / idea flooding.** If voice is saturated with ideas: unclear "real" plan, encourages others to flood, "apparent failure of control", missed warnings ([Fleet Command Guide § Communication discipline](https://wiki.eveuniversity.org/Fleet_Command_Guide)); remedy words `Brevity!`/`Break break` ([Brevity codes](https://wiki.eveuniversity.org/Brevity_codes)). *Folie:* never show raw agent↔agent chatter in the main feed; offer a "break" key that mutes all but `must-act`.
2. **Long, compound orders fail under stress.** Keep ≤6–7 words; examples of bad multi-clause commands ([Fleet Command Guide § Keeping commands short](https://wiki.eveuniversity.org/Fleet_Command_Guide)). *Folie:* single-intent commands; the line editor warns on compound commands. [INFERENCE for the warning]
3. **Notification fatigue via severity inflation.** "Use `@here` sparingly and `@everyone` rarely… annoy people to the point where they turn off/ignore pings" ([WHSOC](https://whsoc.fandom.com/wiki/Discord_Ping_Etiquette)); each message notifies mobile/desktop/email ([EVE Uni Discord](http://wiki.eveuniversity.org/Discord)). Clinical parallel: alarm fatigue = repeated non-actionable alarms → desensitisation ([BMC Nursing scoping review, search excerpt](https://link.springer.com/article/10.1186/s12912-025-03369-2); [Joint Commission SEA 50](https://www.kff.org/wp-content/uploads/sites/8/2013/04/sea_50_alarms_4_5_13_final1.pdf), not read in full). *Folie:* every alert kind must name the action it asks for; alerts with no action become silent log rows.
4. **Ping over-use becomes distraction.** HotS ping frequency had an inverted-U vs performance ([cited in Lee et al.](https://arxiv.org/pdf/2502.17935)); Dota players spam pings to emote/flame (8.1% emoting) ([Wuertz et al.](http://library.usc.edu.ph/ACM/CHI%202017/1proc/p1978.pdf)). *Folie:* rate-limit and dedupe pings per entity; coalesce repeats into `×N`.
5. **Communication read as a symptom of trouble / blame channel.** LoL players treat frequent communication as a precursor to breakdown and use "Enemy Missing" pings to call out teammates ([Lee et al.](https://arxiv.org/pdf/2502.17935)); EVE FC guide: never hammer a pilot publicly, use names only as last resort ([Fleet Command Guide § Correcting pilot errors](https://wiki.eveuniversity.org/Fleet_Command_Guide)). *Folie:* [INFERENCE] agent "failures" should show cause + remedy, not accusatory state; a human frustrated at the swarm is the real risk — don't let the UI encourage spamming agents.
6. **Misconfigured overview = friendly fire / hidden threats.** "A misconfigured overview can result in the loss of a ship or worse, a diplomatic incident of friendly fire"; colour-tag order can hide a war target behind a bounty icon ([Overview](https://wiki.eveuniversity.org/Overview), [Overview settings](https://wiki.eveuniversity.org/Overview_settings)). *Folie:* colour rules ordered by *severity*, enforced, previewed.
7. **Stale filters silently omit new things.** Overviews older than a release "will be missing" new entity types ([Overview](https://wiki.eveuniversity.org/Overview)). *Folie:* default-include unknown alert/state kinds; show "N uncategorised".
8. **Importing someone else's view wrecks yours.** Overview import can blend with existing settings; Appearance/Columns weren't exported in XML; history tab with Restore button exists as the fix ([Overview settings](https://wiki.eveuniversity.org/Overview_settings)). *Folie:* views are whole-file, versioned, with `restore previous`.
9. **Lists reshuffling under the cursor.** EVE freezes overview sorting while a modifier is held ([Overview § Locked Status](https://wiki.eveuniversity.org/Overview)). *Folie:* never re-sort the roster during interaction; append-only until release.
10. **Information overload in the *automated* assistant.** Blizzard's timeline showed tank-buster timers to DPS, mistimed Dread Breath by 3–4 s, omitted a core soak; addons remain mandatory because the base feature lacks agency ([Icy Veins](https://www.icy-veins.com/wow/news/blizzards-boss-timeline-still-cant-replace-dbm-creator-shows-why)). *Folie:* per-role filters on projected alerts; a wrong projection is worse than none — label estimates.
11. **Single point of command failure.** FC loss is "utter disaster"; need 2IC/3IC; don't command from the pod ([Fleet Command Guide § Protecting command](https://wiki.eveuniversity.org/Fleet_Command_Guide)). *Folie:* the human *is* a SPOF — lead agents need a documented autopilot ROE for "operator away".
12. **Role over-grant.** Rent Office role needs no wallet access and can waste the corp wallet; Director includes everything; grantable roles can escalate ([Managing corporation members](https://wiki.eveuniversity.org/Managing_corporation_members)). *Folie:* spend/spawn capability must be explicit and non-implied by lead status.
13. **Channel leakage.** EVE Uni forbids discussing fleet moves in corp/alliance chat and Discord channels outside the fleet; stream delays ([Rookie's Guide § Operational security](https://wiki.eveuniversity.org/The_Rookie%27s_Guide_to_Fleet_Ops)). *Folie:* [INFERENCE] transcripts may contain secrets — redaction before any "linkable" scan output.
14. **Chatting in alert channels.** "DO NOT CHAT in ping channels" ([WHSOC](https://whsoc.fandom.com/wiki/Discord_Ping_Etiquette)); EVE Uni moves discussion to threads ([EVE Uni Discord](http://wiki.eveuniversity.org/Discord)). *Folie:* broadcast panel read-only; replies create a thread/task.
15. **Over-drawing the battlefield.** Brackets cause server lag with hundreds of pilots; recommended off ([Overview § Filtering](https://wiki.eveuniversity.org/Overview)). *Folie:* [INFERENCE] polling/render cost scales with agent count; detail level auto-reduces beyond N agents.
16. **Spam x-up / duplicate signals hamper assignment.** "Do not spam your x-up" ([Rookie's Guide](https://wiki.eveuniversity.org/The_Rookie%27s_Guide_to_Fleet_Ops)). *Folie:* idempotent offers (existing `clientRequestId`-style dedupe in `SendMessageRequest`).
17. **Plans locked at engagement.** FFXIV waymarks can't be placed once combat starts ([Using Waymarks](https://na.finalfantasyxiv.com/uiguide/battle/battle-target/fieldmarker_how.html)); EVE Uni: get final plan out within two minutes of fighting ([Fleet Command Guide](https://wiki.eveuniversity.org/Fleet_Command_Guide)). *Folie:* [INFERENCE] structural edits (re-parent wings, change ROE) while a goal is mid-flight need a confirm; tags/priority stay editable.

---

## 6. Proposed from-scratch Folie TUI information architecture

Design stance: **the human is a fleet commander who mostly watches exceptions, issues short orders, and drills down by scan.** Everything keys off one object model (agent, goal, task, topic, message) and one attention queue.

### 6.1 Screen layout (single persistent frame, no mode switching for primary tasks)

```
┌ header: swarm · FC:<you> · agents 23 (▶12 ◆4 ⏸3 ⚠2 ✕2) · burn $/h · alerts N · dnd ─────────────────────────┐
│ ROSTER (hier.)                 │ BROADCAST HISTORY (typed, 1 line each)  │ WATCHLIST (pinned 3–6 cards)        │
│ ▾ Wing α (lead a1)  ▶▶▶◆⏸      │ 12:01 NEED-REVIEW a7 ·t42 ·verif v9     │ a1 ▶ t17 lease 4m  $0.31/10m        │
│   ▸ Sq g12 (4)  ▶▶◆▶           │ 12:00 BLOCKED   a4 ·t40 ·policy         │ g12 ▶ 3/5 tasks  P                  │
│   ▸ Sq g15 (3)  ▶⚠⏸            │ 11:58 DONE      a2 ·g11 ✓               ├─────────────────────────────────────┤
│ ▾ Wing β (lead b1) …           │ …                                       │ SCAN / INSPECTOR (d-scan style)     │
├────────────────────────────────┴─────────────────────────────────────────┤ result of last scan, linkable       │
│ COMMS (focused channel/topic: #goal-12 · thread)      [stream]           │                                     │
├──────────────────────────────────────────────────────────────────────────┴─────────────────────────────────────┤
│ tabs: 1 Ops  2 Attention  3 Work  4 Money  5 Comms  6 History  7 Custom…     /cmd or text → #goal-12 ▌          │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Panels (each maps to something Folie already has):
1. **Roster** (EVE fleet window/composition): hierarchy by default, flat toggle; scoped; columns `name · role · state glyph · goal/task · last-heard · lease · burn`; groups collapse to summary glyph strings (one glyph per member).
2. **Broadcast history** (EVE broadcast tab + History): typed agent-state signals + system alerts, newest first, grouped/deduped, per-kind subscription and colour; selecting one jumps roster + scan to its subject.
3. **Comms** (Fleet chat + typed mirror): the unified stream — messages, orders, pings, acks — all as text rows (LoL's single textual channel principle, [Lee et al.](https://arxiv.org/pdf/2502.17935)). Channel tabs: `#all`, `@dm`, each topic; unread counters per channel.
4. **Watchlist**: pinned cards, always visible regardless of tab.
5. **Scan/Inspector** (d-scan): scoped cheap snapshot; transcript tail opens in a full-screen *drilldown* only on demand.
6. **Attention queue** (tab 2, also the `a` badge): ordered list of items needing the human, each with the single requested action and a countdown if any. This replaces today's `alerts` as the primary view; it is the "must-act" tier. Existing `buildAlerts` ordering (critical, newest) stays.
7. **Work** (goals/tasks): tree of goals → tasks with claim/fence/lease, P/S/T tags, verification status; task rows show owner and lease countdown.
8. **Money** (budgets): existing carve-out tree + burn-rate projection with labeled estimates.
9. **History** (killmails + ledger): per-goal outcome cards; ledger filtered by claims/roles/costs; member history.
10. **Overview tabs 1–8** are *saved views* over the above (filter × columns × sort × colour rules); shareable files.

### 6.2 Command grammar

Prefix rules (Warframe slash commands, [Chat § Commands](https://wiki.warframe.com/w/Chat); EVE's `/open overview settings` slash command, [Overview settings](https://wiki.eveuniversity.org/Overview_settings); Discord `@` mentions, [EVE Uni Discord](http://wiki.eveuniversity.org/Discord)):
- Plain text = message to the focused channel (shown in header: `→ #goal-12`). `/verb …` or `:verb …` = command (keep `:` for continuity).
- Address sigils: `@agent`, `@wing:α`, `@all`, `#topic`, `+<goalId>`, `~<taskId>`, `%<group>` (control group). Voice-procedure form `to ← from: body` rendered consistently.
- Modifiers: `!` urgency (`!!` must-act), `?` asks for ack, `--roe hold|tight|free`.
- ≤ ~7 tokens for orders; longer text goes in the message body, not the verb line.

| Command | EVE/other analogue | Folie effect (existing backend unless marked `new`) |
|---|---|---|
| `/msg @a [text]` / bare text | whisper `/w`, `Squad 1:` | `send` |
| `/pub #topic text` | channel talk | `publish` |
| `/sub #topic [@a]` `/unsub …` | channel join | `subscribe/unsubscribe` |
| `/go [@a] <goal>` | primary call | `submit` (alias of today's `submit`) |
| `/fleet new|save|load|rename` | store/load fleet setup | `new`: team template |
| `/fleet move @a wing:β` | move member | `new`: hierarchy edit |
| `/wing add|rm|lead @a` | promote WC | `new` |
| `/role grant|revoke @a <role>` | corp roles | `new`: capability grants → ledger |
| `/broadcast <kind> [@scope] [note]` | fleet broadcast | `new`: typed message kind+scope (human may broadcast too: `hold`, `regroup`, `new-picture`) |
| `/bc subscribe|mute <kind>` | broadcast settings | client-side |
| `/watch @a|+g` `/unwatch` | watchlist | client-side |
| `/tag +g P|S|T|1..8` `/untag` | tags/markers | `new`: priority attribute |
| `/scan [@a|+g|#t] [--win 10m] [--every 10s]` | d-scan | reads sessions/ledger; client-side repeat |
| `/regroup [@scope]` | Regroup | `new` signal: checkpoint+report |
| `/hold [@scope]` / `/resume` | Hold Position / Resume | `suspend`/`resume` (control signal) |
| `/scatter [@scope]` | Scatter | pause-all (control signal) |
| `/bugout [@scope]` | Bugout | `cancel` with save |
| `/cancel @a [reason]` | — | existing `cancel` |
| `/x <role> [+g]` | x-up | `new`: capability offer / claim request |
| `/roe <hold|tight|free> [@scope]` | Weapons hold/tight/free | `new`: autonomy attribute on goal/wing |
| `/view <name>` `/view save|share` | overview preset | client-side saved views |
| `/dnd [dur]` `/normal` | Warframe dnd | client-side + broadcast to leads |
| `/ack [id]` / `/unable id reason` (agents) | Roger/Wilco/Unable | `new`: order ack states |

### 6.3 Presence model

Derive from heartbeat/lease/session data (so it is not self-reported lying). [INFERENCE: field availability unaudited]
- **Glyph + words** (never colour alone): `▶ active` (session running), `◇ idle` (no claim), `… waiting` (blocked on dependency/human; show on what), `⏸ paused` (control signal), `⚠ stalled` (no progress beyond threshold, matches `stall`), `✕ lost` (lease expired / `execution_lost`), `✓ done`, `○ offline`.
- **Last-heard age** next to every row, in EVE-member-list style coarse buckets (the corp list is deliberately coarse + delayed, [Managing corporation members](https://wiki.eveuniversity.org/Managing_corporation_members)); fine-grained only in the scan.
- **"In system"** = same goal subtree; **"on grid"** = same task/claim; **Local** strip per goal/topic with count and spike indicator.
- **Hierarchy roll-up**: a wing shows `▶▶▶◆⏸` and its worst state; healthy wings collapse to one line.

### 6.4 Broadcast taxonomy for agent states

Closed set, each with audience default, who can be recipient, and the existing alert source (so no information invented):

| Kind | Meaning | Default scope | Routed to | Existing signal |
|---|---|---|---|---|
| `NEED-HELP` | stuck, want another agent/human | superiors | lead; escalates to human if no taker | — new |
| `NEED-REVIEW` | submitted, awaiting verification | my group | reviewer agents / lead | verification pending |
| `NEED-DECISION` | requires human approval/choice | superiors → human | human (tier must-act if expiring) | `approval_expiring` |
| `NEED-BUDGET` | budget exhausted/near | superiors | lead → human | `budget_exhausted` |
| `BLOCKED(on)` | cannot proceed (dep/policy/fence) | superiors | lead | `policy_denied`, `stale_fence_conflict` |
| `REJECTED` | verification failed; will retry or needs input | my group | lead | `verification_rejected` |
| `STALLED` | no progress | superiors | lead, human if wing-wide | `stall` |
| `LOST` | agent/execution gone | everyone | lead + succession | `execution_lost` |
| `IN-POSITION/READY` | claimed and set up | my group | lead | claim/start |
| `HOLDING` | paused on order | my group | lead | control signal ack |
| `DONE(ok|fail)` | outcome | superiors | lead; killmail card | report/ledger |
| `CONTACT` | anomaly/finding worth attention | superiors | lead; human if tagged | — new |
| `NEW-PICTURE` | plan changed; supersedes prior calls | my group | all in scope | — new, from EVE |
| `SYS: UNDELIVERED` | system issue | human | human | `undelivered_publication` |

Tiers: `info` (history only), `warn` (badge+strip), `must-act` (bell/flash; only for `NEED-DECISION`, `LOST` on a P-tagged goal, `NEED-BUDGET` at hard stop). Everything else may *not* interrupt. Attention queue = `NEED-DECISION` ∪ must-act ∪ `NEED-HELP` with no taker after T. Format per line ≤ 100 cols: `HH:MM KIND agent · subject · why(≤40ch) · [action]`.

### 6.5 Roles and hierarchy

- **Human = FC + Boss.** FC verbs: orders, tags, ROE, `/regroup /scatter`. Boss verbs: roles, budgets, promotions, fleet templates (separated, as in [Fleet leadership](https://wiki.eveuniversity.org/Fleet_leadership)).
- **Lead agents = Wing Commanders**: own a goal subtree, own sub-squad formation, receive `superiors`-scoped broadcasts, may re-assign inside the subtree, escalate by exception. Humans address leads, not workers (default `@wing`).
- **Workers = squad members**; **scout** (read-only recon, reports intel format); **reviewer** (verifier; receives `NEED-REVIEW`); **booster** (shared context pack provider) optional.
- **Succession**: `2IC` named per wing; promotion event recorded; human can `/wing lead`.
- **ACL**: capability roles + titles + grantable; audit via ledger; no implicit power from lead rank (cf. Rent Office hazard).
- **Intent block per goal**: purpose, end state, ROE level, budget carve-out, escalation conditions — the mission-command order ([ADP 6-0](https://armyadp.com/publications/adp-6-0/mission-command-principles)).

### 6.6 Keyboard model

Guiding rules: *every action reachable by one chord; recall and cycle over search; never reorder rows during an action; commands typed only when no hotkey exists* (EVE: "almost all actions have shortcuts", hold-key+click and select-then-key both work: [Overview § Shortcuts](https://wiki.eveuniversity.org/Overview); SC2: "never click the command card", [guide](https://tictactactics.wordpress.com/2015/07/18/the-beginners-guide-to-starcraft-2-part-ii-hotkeys)).

| Keys | Action |
|---|---|
| `1`–`8` | switch saved view/tab |
| `Ctrl+1..9` / `1..9` (on roster focus) | bind selection to group / recall group; `Shift+n` add |
| `Tab` / `Shift+Tab` | cycle panels; inside a group cycle members |
| `j k` / arrows, `h l` | move, collapse/expand hierarchy |
| `Space` | mark/select (freezes ordering while active) |
| `.` / `,` | next/prev attention item |
| `i` | next idle agent |
| `a` | attention queue |
| `s` | scan focused entity; `S` repeat-scan toggle |
| `p` | ping menu on focused row: look / status? / hold / go |
| `w` | watch/unwatch |
| `t` | tag P/S/T/1–8 |
| `Enter` | open drilldown (transcript, task) |
| `b` | broadcast menu (typed kinds) |
| `/` | filter current panel (inclusive; prefix `!` exclusive — Warframe-style, [Chat § Filtering](https://wiki.warframe.com/w/Chat)) |
| `:` or `/` at empty prompt | command line (history ↑↓, tab completion of `@ # + ~` ids) |
| `Esc` | clear selection/filter, leave drilldown |
| `d` | density toggle (compact/detailed) |
| `z` | break! mute below must-act for 60 s |
| `?` | help overlay generated from the same registry as `/help` |

### 6.7 Parallel-visibility strategy for 20+ agents

1. **One row per agent, ≤1 line, fixed columns**; 20–40 rows fit in a 50-row terminal; rows beyond N collapse by group.
2. **Roll-up glyph strips per group** (like WoW raid group cells, FFXIV party list): `▶▶▶◆⏸⚠` scans in <1 s.
3. **Exception-first ordering** within a group (worst state first) *but frozen* during interaction ([Overview § Locked Status](https://wiki.eveuniversity.org/Overview)).
4. **Watchlist** for the 3–6 things worth full detail; **everything else peripheral** (EVE: FC filters; LoL: minimap+scoreboard+pings carry context, [Lee et al.](https://arxiv.org/pdf/2502.17935)).
5. **Control groups** to address subsets without scrolling.
6. **Scans are the only expensive reads**, rate-limited (EVE's 2 s scan cooldown, [Directional scanning](https://wiki.eveuniversity.org/Directional_scanning)); steady-state UI polls only summary rows. Detail level auto-drops with agent count (bracket lesson).
7. **Wide-terminal mode**: three columns as drawn; **narrow**: tabs, one panel at a time, header strip stays.
8. **Hidden counters** everywhere filters apply (`hidden 7`), unknown kinds fail open.
9. **Typed mirror of orders** keeps a durable, replayable command history so operator disconnects don't lose intent.

---

## 7. Open questions and risks

### 7.1 Open questions
- **Hierarchy storage:** are wing/squad/role first-class backend fields, or derived (root goal = wing, goal = squad)? Derivation is cheaper and avoids a second source of truth. [INFERENCE: not audited.]
- **Who classifies agent states for broadcasts:** self-reported (EVE "Need Armor" is pilot-pressed) vs backend-derived? Self-report invites mis-signalling by LLM agents; derive where a ledger/lease fact exists, accept self-report only for `NEED-HELP`/`CONTACT`.
- **Are broadcasts a new message kind or a projection of ledger events?** Message kind enables agent-originated signals and routing; projection avoids duplication.
- **ROE semantics:** which concrete powers (spawn, claim, spend, publish) map to hold/tight/free, and how enforced (policy denies vs advisory)? Existing budget enforcement tiers (E0/E1/E2) show enforcement is not uniform yet ([`model.ts`](../../src/tui/model.ts)).
- **Order acks:** do agents reliably emit Roger/Wilco/Unable? Without acks the typed mirror is one-way.
- **How much of an agent transcript can be shown/linked safely** (secrets, PII)?
- **Is the operator multi-human?** EVE/Discord assume many humans; Folie today appears single-operator — Boss/FC split may be unneeded until then.

### 7.2 Risks
- **Over-importing spatial metaphors.** EVE's grid, range, warp and cloak mechanics have no Folie analogue; copy *information architecture*, not mechanics. The hierarchy page cited for bonuses is itself marked deprecated ([Fleet leadership](https://wiki.eveuniversity.org/Fleet_leadership)).
- **Hierarchy latency/cost:** leads add LLM turns between human and worker; EVE humans absorb that as cheap chat. [INFERENCE] Provide a direct `@worker` bypass and measure lead overhead.
- **Notification design is the product.** If `must-act` inflates, the system trains the operator to ignore it ([WHSOC](https://whsoc.fandom.com/wiki/Discord_Ping_Etiquette), [BMC Nursing](https://link.springer.com/article/10.1186/s12912-025-03369-2)). Require each alert kind to have an owner, an action, and a measured actionable-rate.
- **Estimates erode trust when wrong** (Blizzard timeline). Label projected timers; hide when confidence is low.
- **Automating command signals** is policy-sensitive: WoW made `SetRaidTarget` protected in 12.0.0 ([SetRaidTarget](https://warcraft.wiki.gg/wiki/API_SetRaidTarget)); rationale unknown. [INFERENCE] Keep human-only verbs (`/roe`, `/role`, `/bugout` on P goals) non-automatable by agents.
- **Terminal limits:** colour support, width, accessibility (existing code states "status never rests on colour alone" in `alertsLines`); glyph-only states need screen-reader-friendly word equivalents.
- **Operator as SPOF/overload:** no data in this research on how many LLM agents one human can supervise; the 3–5 leads figure is borrowed from EVE span-of-control. [INFERENCE] Needs usability testing with real runs.
- **Scope creep:** this brief proposes ~20 features; ship order suggestion [INFERENCE]: (1) attention queue + typed broadcasts, (2) saved views + freeze + hidden counters, (3) scan, (4) control groups/keys, (5) hierarchy/ROE/roles, (6) pings, timers, templates.

### 7.3 Evidence quality and gaps
- Strong primary: EVE University wiki pages (community-maintained, not CCP, but detailed and current to 2026), Warframe wiki, FFXIV Lodestone manual, Discord support, CHI papers (Dota, LoL).
- Secondary/weak: ADP 6-0 via third-party summary; SC2 via a blog (Liquipedia 403); alarm-fatigue via a search excerpt; WoW via wiki.gg + news.
- Not retrieved / unverified: CCP dev blogs (search returned only an old EVE Voice/UI post and patch notes — none used); EVE notifications, mail, market/contracts, Jabber bridges; WoW raid frames and ready check primary docs; FFXIV party finder/linkshell; Riot ping design blog; Minecraft; any quantitative EVE tractability data.
