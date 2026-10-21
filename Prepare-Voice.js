const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const voiceRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'JARVIS', 'voice');
const modelRoot = path.join(voiceRoot, 'kokoro-multi-lang-v1_0');
const sherpa = require(path.join(voiceRoot, 'node_modules', 'sherpa-onnx-node'));
const speakers = [24, 25, 26, 27];

async function main() {
  const tts = await sherpa.OfflineTts.createAsync({
    model: {
      kokoro: {
        model: path.join(modelRoot, 'model.onnx'),
        voices: path.join(modelRoot, 'voices.bin'),
        tokens: path.join(modelRoot, 'tokens.txt'),
        lexicon: path.join(modelRoot, 'lexicon-gb-en.txt'),
        dataDir: path.join(modelRoot, 'espeak-ng-data')
      },
      debug: false,
      numThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
      provider: 'cpu'
    },
    maxNumSentences: 1,
    silenceScale: 0.2
  });

  for (const sid of speakers) {
    const generationConfig = new sherpa.GenerationConfig({ sid, speed: 0.94, silenceScale: 0.2 });
    const audio = await tts.generateAsync({ text: 'Yes, sir?', generationConfig });
    if (!audio?.samples?.length || !audio.sampleRate) throw new Error(`Kokoro returned no audio for British voice ${sid}.`);
    sherpa.writeWave(path.join(voiceRoot, `wake-ack-${sid}.wav`), {
      samples: audio.samples,
      sampleRate: audio.sampleRate
    });
    console.log(`Prepared instant wake reply for British voice ${sid}.`);
  }
}

main().catch((error) => {
  console.error(`Voice preparation failed: ${error.message || error}`);
  process.exitCode = 1;
});
