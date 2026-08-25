// Szerverhibák kódjai.
//
// A szerver NEM küld kész szöveget: nem tudja, milyen nyelven játszik a
// kliens, és egy szobában többféle nyelvű játékos is ülhet. Ezért kódot küld,
// a szöveg a kliens nyelvfájljából jön (`server.<kód>` kulcs).
//
// Ahol részlet is tartozik a hibához (pl. az eredeti kivétel szövege), azt a
// `detail` mező viszi — az technikai adat, nem fordítjuk.
export const ERR = Object.freeze({
  PROFILE_IN_ROOM: 'profileInRoom',
  BAD_TOKEN_FORMAT: 'badTokenFormat',
  RESTORE_UNAVAILABLE: 'restoreUnavailable',
  NO_PROFILE_FOR_TOKEN: 'noProfileForToken',
  LOGIN_FIRST: 'loginFirst',
  RENAME_BEFORE_ROOM: 'renameBeforeRoom',
  RENAME_FAILED: 'renameFailed',
  NAME_FIRST: 'nameFirst',
  NO_SUCH_MAP: 'noSuchMap',
  NO_SUCH_CAR: 'noSuchCar',
  ROOM_CODE_FAILED: 'roomCodeFailed',
  HOT_LAP_START_FAILED: 'hotLapStartFailed',
  NO_SUCH_ROOM: 'noSuchRoom',
  HOT_LAP_IS_SOLO: 'hotLapIsSolo',
  ROOM_FULL: 'roomFull',
  RACE_ALREADY_STARTED: 'raceAlreadyStarted',
  ALREADY_IN_ROOM: 'alreadyInRoom',
  ROOM_LEFT: 'roomLeft',
  NO_CAR_SWAP_IN_RACE: 'noCarSwapInRace',
  READY_ONLY_WHILE_LOADING: 'readyOnlyWhileLoading',
  READY_NEEDS_STATE: 'readyNeedsState',
  BAD_INITIAL_STATE: 'badInitialState',
  INITIAL_STATE_REJECTED: 'initialStateRejected',
  NOT_IN_ROOM: 'notInRoom',
  HOST_ONLY_START: 'hostOnlyStart',
  UNKNOWN_MESSAGE: 'unknownMessage',
  RACE_START_FAILED: 'raceStartFailed',
  RACE_LOAD_TIMEOUT: 'raceLoadTimeout',
  BAD_JSON: 'badJson',
  SERVER_ERROR: 'serverError',
});
