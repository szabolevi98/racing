# Kocsi-konfigurációk mentése

`car-json-2026-08-03/` — a 106 kocsi `assets/cars/*.json` fájlja **abban az
állapotban, ahogyan kézzel készültek**, mielőtt a `tools/propose.mjs`
automatikával újraértékeltük volna őket (2026-08-03).

Miért maradt meg: a régi minták kézi kutatómunka eredményei, és több helyen
olyan csapdákat dokumentálnak, amiket az automatika nem talál meg magától. A
felülvizsgálat után **17 kocsinál a régi minta bizonyult jobbnak**, azoknál
ezek a fájlok kerültek vissza (a `_wheelPattern` mezőjükben ott az indoklás,
hogy miért).

Ha egy kocsi kereke a jövőben rosszul viselkedik, itt megnézhető, mi volt a
korábbi minta, és mit dokumentált róla a kézi vizsgálat.

## Hogyan dőlt el, melyik minta a jobb

Élő A/B teszt a valódi motorral: mindkét mintával betöltöttük a kocsit, majd
mértük

- **szélesség / átmérő arány** — egy kerék sosem szélesebb, mint amilyen
  magas, tehát 1.0 fölötti érték azt jelenti, hogy valami oda nem való darab
  lóg a kerék-pivotban;
- **kilengés 180 fokos forgatásnál** — mennyit ugrik a kerék, ha megpörgetjük;
- **hány mesh forog együtt a kerékkel** — azonos minőség mellett a több a jobb,
  mert kevesebb alkatrész marad állva.
