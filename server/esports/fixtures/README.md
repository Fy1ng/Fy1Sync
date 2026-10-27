# Liquipedia parsing fixture

Source: [Liquipedia Counter-Strike matches API](https://liquipedia.net/counterstrike/api.php?action=parse&page=Liquipedia:Matches&format=json&prop=text).
Retrieved by the UI handoff on 2026-10-27, reused from its local `.runtime-cache/events/lp.json`.
Content by Liquipedia contributors, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).

`liquipedia-matches.json` retains 9 match blocks from that response (indexes 0, 1, 2, 3, 20, 50, 70, 29, 31), without changing the retained HTML. Unrelated page content and 89 matches were removed. It includes two simultaneous live channels, upcoming games, TBD teams, a missing team-page suffix, finished games and literal group-position placeholders. Empty literal opponents are represented as TBD. The upstream sample has only global tier filters and no per-match tier attributes, so these matches have unknown tiers. Tests add explicitly labelled synthetic variations for missing selectors and tier metadata.

## Tournament tier listing fixtures

The tier fixtures reuse the read-only 2026-10-27 handoff captures, as explicitly authorized by `handoff/TIER-HANDOFF-2026-10-27.md`. No network request or real application profile was used to create them. Content by Liquipedia contributors is licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).

| Fixture | Source API page | Local capture | Retained listing / body row indexes (zero-based) |
| --- | --- | --- | --- |
| `liquipedia-s-tier.json` | [S-Tier_Tournaments](https://liquipedia.net/counterstrike/api.php?action=parse&page=S-Tier_Tournaments&format=json&prop=text) | `.runtime-cache/events/tiers.json` | Listing 1: rows 0, 4, 28 |
| `liquipedia-a-tier.json` | [A-Tier_Tournaments](https://liquipedia.net/counterstrike/api.php?action=parse&page=A-Tier_Tournaments&format=json&prop=text) | `.runtime-cache/events/A-Tier_Tournaments.json` | Listing 0: rows 3, 13 |
| `liquipedia-b-tier.json` | [B-Tier_Tournaments](https://liquipedia.net/counterstrike/api.php?action=parse&page=B-Tier_Tournaments&format=json&prop=text) | `.runtime-cache/events/B-Tier_Tournaments.json` | Listing 0: rows 16, 22, 23 |

Each fixture retains the original listing container, table header and selected complete body rows. Cropping used parse5 source offsets and substring removal, without serializing or altering retained HTML. The retained rows deliberately include game-icon, team-placement and region links as interference. S/A/B captures contain 98/49/138 genuine tournament body rows respectively; broader counts that include other page links do not establish tier membership.

The observed selector is `.tournaments-listing table.table2__table > tbody > tr.table2__row--body > td.column__tournament > a[href]`. Class entities such as `table2&#95;&#95;row--body` are decoded by the HTML parser. Only the direct tournament-column anchor establishes membership; icon, placement, region, header and navigation links are excluded. Tests add clearly labelled synthetic navigation, selector-drift and C-tier variants. The C-tier variant demonstrates layout reuse and is not a captured C-tier response.
