// Thump preset kits. Pads are listed bottom row first (pad 1 = bottom left,
// note 36), left to right, matching the SMC-PAD Pocket. Each entry is a
// sound id, or [id, {options}] with options from: vol, pitch, len, drive,
// pan, hold, rev, cut. cut = choke group (pads in a group cut each other off).
(function () {
  const HAT = { cut: 1 }, BASS = { hold: true, cut: 2 };
  const kit = (id, name, bpm, pads) => ({ id, name, bpm, pads });
  window.THUMP_PRESETS = [
    kit('dubstep', 'Dubstep', 140, [
      'syn:dub-kick', 'syn:dub-snare', ['syn:hat-closed', HAT], ['syn:hat-open', HAT],
      'syn:sub-boom', 'syn:clap-stack', 'syn:shaker', 'syn:rev-crash',
      ['syn:wobble', BASS], ['syn:growl', BASS], ['syn:wobble-fast', BASS], ['syn:sub-bass', BASS],
      'syn:riser', 'syn:impact', 'syn:zap', 'syn:horn',
    ]),
    kit('riddim', 'Riddim / neuro', 150, [
      'syn:dub-kick', 'syn:riddim-snare', ['syn:trap-hat', HAT], ['syn:hat-open', HAT],
      'syn:tight-kick', 'syn:rev-snare', 'smp:audiophob:hand-clap', 'syn:snare-roll',
      ['syn:riddim', BASS], ['syn:neuro', BASS], ['syn:talk', BASS], ['syn:sub-wobble', BASS],
      'syn:uplifter', 'syn:drop-hit', 'syn:laser', ['syn:screech', { hold: true, cut: 3 }],
    ]),
    kit('audiophob', 'Audiophob dubstep', 140, [
      'smp:audiophob:kick', 'smp:audiophob:snare-rock', ['smp:audiophob:closed-hh', HAT], ['smp:audiophob:open-hh', HAT],
      'smp:audiophob:stick', 'smp:audiophob:hand-clap', ['smp:audiophob:pedal-hh', HAT], 'smp:audiophob:snare-jazz',
      ['syn:wobble', BASS], ['syn:talk', BASS], 'smp:audiophob:tom-low', 'smp:audiophob:tom-hi',
      'syn:riser', 'smp:audiophob:crash', 'smp:audiophob:ride-jazz', 'syn:drop-hit',
    ]),
    kit('industrial', 'Industrial', 130, [
      'syn:dist-kick', 'syn:ind-snare', ['syn:tick-hat', HAT], ['smp:trash:open-hat', HAT],
      'syn:gabber-kick', 'smp:trash:snare', ['smp:trash:closed-hat', HAT], 'smp:trash:crash-trash',
      'syn:stomp', 'syn:clang', 'syn:anvil', 'syn:pipe',
      ['syn:reese', BASS], 'syn:static', 'syn:grinder', 'syn:siren',
    ]),
    kit('factory', 'Factory (industrial 2)', 120, [
      'smp:vari:varibreaks-kick-2', 'smp:vari:varibreaks-snare-2', ['syn:tick-hat', HAT], ['smp:vari:varibreaks-hat-1-op', HAT],
      'syn:hammer', 'syn:chain', 'syn:sheet', 'syn:dist-tom',
      'syn:press', 'syn:servo', 'syn:radio', ['syn:dark-pad', { hold: true, cut: 3 }],
      'syn:power-down', 'syn:alarm', 'syn:beeps', 'syn:drop-hit',
    ]),
    kit('electro', 'Electro / techno', 128, [
      'smp:hard:kick-1', 'smp:hard:clap-1', ['smp:hard:closed-hh-1', HAT], ['smp:hard:open-hh', HAT],
      'syn:punch-kick', 'smp:hard:snare', ['smp:hard:closed-hh-2', HAT], 'smp:808:cowbell',
      'smp:hard:zap-1', 'syn:glitch', 'syn:rave-stab', 'syn:dark-stab',
      ['syn:pluck-bass', { cut: 2 }], ['syn:yoi-bass', { cut: 2 }], 'syn:downsweep', 'syn:riser',
    ]),
    kit('trap', 'Trap / 808', 140, [
      'smp:808:kick-long', 'smp:808:clap', ['smp:808:closed-hat', HAT], ['smp:808:open-hat', HAT],
      ['syn:808-bass', { cut: 2 }], 'smp:808:snare-1', 'syn:rim-click', 'syn:snap',
      ['syn:808-bass', { cut: 2, pitch: 3 }], ['syn:808-bass', { cut: 2, pitch: 5 }], ['syn:808-bass', { cut: 2, pitch: 7 }], ['syn:808-bass', { cut: 2, pitch: 10 }],
      'syn:bell', 'syn:dark-stab', 'syn:sub-drop', 'syn:noise-burst',
    ]),
    kit('boxes', 'Drum machines', 115, [
      'smp:626:classic-626-kick-1', 'smp:626:classic-626-snare-1', ['smp:626:classic-626-hat-closed', HAT], ['smp:626:classic-626-hat-open', HAT],
      'smp:denon:kick-denon-manual', 'smp:626:classic-626-clap', ['smp:denon:hh-denon-manual', HAT], 'smp:626:classic-626-rim-shot',
      'smp:626:classic-626-tom-1-low', 'smp:626:classic-626-tom-1-mid', 'smp:626:classic-626-tom-1-hi', 'smp:626:classic-626-cowbell',
      'smp:626:classic-626-crash', 'smp:denon:clap-denon', 'smp:626:classic-626-tambourine', 'smp:626:classic-626-conga-hi',
    ]),
    kit('hands', 'Hand drums', 100, [
      'smp:hands:cajon-thump', 'smp:hands:cajon-slap', 'smp:hands:maraca', 'smp:hands:tambourine',
      'smp:africa:djembe1-bass', 'smp:africa:djembe1-tone', 'smp:africa:djembe1-slap', 'smp:hands:hand-clap',
      'smp:africa:dununba1-head-hit', 'smp:africa:kenkeni1-head-hit', 'smp:hands:bongo-lo', 'smp:hands:bongo-hi',
      'smp:626:classic-626-conga-low', 'smp:626:classic-626-conga-hi', 'smp:hands:woodblock-hi', 'smp:hands:finger-snaps',
    ]),
    kit('heavy', 'Heavy metal kit', 120, [
      'smp:metal:kick', 'smp:metal:snare', ['smp:metal:hh-closed', HAT], ['smp:metal:hh-open', HAT],
      'smp:metal:kick-blast', 'smp:metal:snare-blast', ['smp:metal:hh-foot', HAT], 'smp:metal:snare-rim',
      'smp:metal:tom05', 'smp:metal:tom03', 'smp:metal:tom01', 'smp:metal:ride-bell',
      'smp:metal:crash-18', 'smp:metal:china-16', 'smp:metal:ride-bow', 'smp:metal:splash-10',
    ]),
    kit('rock', 'Rock kit', 100, [
      'smp:rock:kick', 'smp:rock:snare', ['smp:rock:hat-closed', HAT], ['smp:rock:hat-open', HAT],
      'smp:rock:snare-rimshot', 'smp:rock:hand-clap', ['smp:rock:hat-pedal', HAT], 'smp:rock:stick',
      'smp:rock:floor-tom', 'smp:rock:tom-2', 'smp:rock:tom-1', 'smp:rock:cowbell',
      'smp:rock:crash', 'smp:rock:ride', 'smp:rock:splash', 'smp:rock:bell',
    ]),
    kit('hiphop', 'Hip-hop', 90, [
      'smp:vari:varibreaks-kick-1', 'smp:vari:varibreaks-snare-1', ['smp:vari:varibreaks-hat-1-cl', HAT], ['smp:vari:varibreaks-hat-1-op', HAT],
      'smp:vari:varibreaks-kick-2', 'smp:vari:varibreaks-snare-3', ['smp:vari:varibreaks-hat-2-cl', HAT], 'smp:808:clap',
      'smp:808:kick-long', 'smp:audiophob:stick', 'smp:vari:varibreaks-snare-2', 'syn:shaker',
      'smp:vari:varibreaks-drum-1', 'smp:vari:varibreaks-drum-2', 'syn:808-bass', 'syn:crackle',
    ]),
    kit('808', 'Classic 808', 120, [
      'smp:808:kick-long', 'smp:808:snare-1', ['smp:808:closed-hat', HAT], ['smp:808:open-hat', HAT],
      'smp:808:kick-short', 'smp:808:clap', ['smp:808:pedal-hat', HAT], 'smp:808:clave',
      'smp:808:tom-low', 'smp:808:tom-mid', 'smp:808:tom-hi', 'smp:808:cowbell',
      'smp:808:cymbal', 'smp:808:snare-2', 'smp:808:shaker', 'smp:808:conga',
    ]),
  ];
})();
