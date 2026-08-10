// A kliens által kirajzolt versenyórák tiszta számítása. A hiteles időpontok
// továbbra is a szervertől jönnek; ez csak eldönti, melyik kezdőponthoz mérünk.
export function raceClockTimes({
  now, raceStartedAt, lapStartedAt, completedTotal = 0, finished = false, hotLap = false,
}) {
  const currentStart = lapStartedAt || raceStartedAt;
  // Hot Lapnál a visszaszámlálás után még felvezető van. Az összidő ezért csak
  // a rajtvonal első átlépésétől indulhat, ugyanúgy, mint az aktuális köridő.
  const totalStart = hotLap ? currentStart : raceStartedAt;
  return {
    currentTime: finished ? 0 : Math.max(0, now - currentStart),
    totalTime: finished ? completedTotal : Math.max(0, now - totalStart),
  };
}
