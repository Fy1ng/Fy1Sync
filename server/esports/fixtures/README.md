# Liquipedia parsing fixture

Source: [Liquipedia Counter-Strike matches API](https://liquipedia.net/counterstrike/api.php?action=parse&page=Liquipedia:Matches&format=json&prop=text).
Retrieved by the UI handoff on 2026-10-27, reused from its local `.runtime-cache/events/lp.json`.
Content by Liquipedia contributors, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).

`liquipedia-matches.json` retains 9 match blocks from that response (indexes 0, 1, 2, 3, 20, 50, 70, 29, 31), without changing the retained HTML. Unrelated page content and 89 matches were removed. It includes two simultaneous live channels, upcoming games, TBD teams, a missing team-page suffix, finished games and literal group-position placeholders. Empty literal opponents are represented as TBD. The upstream sample has only global tier filters and no per-match tier attributes, so these matches have unknown tiers. Tests add explicitly labelled synthetic variations for missing selectors and tier metadata.
