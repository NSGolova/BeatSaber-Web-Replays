if (typeof AFRAME === 'undefined') {
	throw new Error('Component attempted to register before AFRAME was available.');
}

var audioBufferCache = {};

/**
 * Audio visualizer component for A-Frame using AnalyserNode.
 */
AFRAME.registerComponent('audioanalyser', {
	schema: {
		buffer: {default: false},
		isSafari: {default: false},
		beatDetectionDecay: {default: 0.99},
		beatDetectionMinVolume: {default: 15},
		beatDetectionThrottle: {default: 250},
		cache: {default: false},
		enabled: {default: true},
		enableBeatDetection: {default: true},
		enableLevels: {default: true},
		enableWaveform: {default: true},
		enableVolume: {default: true},
		fftSize: {default: 2048},
		smoothingTimeConstant: {default: 0.8},
		src: {
			parse: function (val) {
				if (val.constructor !== String) {
					return val;
				}
				if (val.startsWith('#') || val.startsWith('.')) {
					return document.querySelector(val);
				}
				return val;
			},
		},
		unique: {default: false},
	},

	init: function () {
		this.audioEl = null;
		this.levels = null;
		this.waveform = null;
		this.volume = 0;
		this.xhr = null;

		this.initContext();
	},

	update: function (oldData) {
		var analyser = this.analyser;
		var data = this.data;

		// Update analyser stuff.
		if (oldData.fftSize !== data.fftSize || oldData.smoothingTimeConstant !== data.smoothingTimeConstant) {
			analyser.fftSize = data.fftSize;
			analyser.smoothingTimeConstant = data.smoothingTimeConstant;
			this.levels = new Uint8Array(analyser.frequencyBinCount);
			this.waveform = new Uint8Array(analyser.fftSize);
		}

		if (!data.src) {
			return;
		}
		this.refreshSource();
	},

	/**
	 * Update spectrum on each frame.
	 */
	tick: function (t, dt) {
		var data = this.data;
		var volume;

		if (!data.enabled) {
			return;
		}

		// Levels (frequency).
		if (data.enableLevels || data.enableVolume) {
			this.analyser.getByteFrequencyData(this.levels);
		}

		// Waveform.
		if (data.enableWaveform) {
			this.analyser.getByteTimeDomainData(this.waveform);
		}

		// Average volume.
		if (data.enableVolume || data.enableBeatDetection) {
			var sum = 0;
			for (var i = 0; i < this.levels.length; i++) {
				sum += this.levels[i];
			}
			this.volume = sum / this.levels.length;
		}

		// Beat detection.
		if (data.enableBeatDetection) {
			volume = this.volume;
			if (!this.beatCutOff) {
				this.beatCutOff = volume;
			}
			if (volume > this.beatCutOff && volume > this.data.beatDetectionMinVolume) {
				this.beatCutOff = volume * 1.5;
				this.beatTime = 0;
			} else {
				if (this.beatTime <= this.data.beatDetectionThrottle) {
					this.beatTime += dt;
				} else {
					this.beatCutOff *= this.data.beatDetectionDecay;
					this.beatCutOff = Math.max(this.beatCutOff, this.data.beatDetectionMinVolume);
				}
			}
		}
	},

	initContext: function () {
		var data = this.data;
		var analyser;
		var gainNode;

		this.context = new (window.webkitAudioContext || window.AudioContext)();
		analyser = this.analyser = this.context.createAnalyser();
		gainNode = this.gainNode = this.context.createGain();
		gainNode.connect(analyser);
		analyser.connect(this.context.destination);
		analyser.fftSize = data.fftSize;
		analyser.smoothingTimeConstant = data.smoothingTimeConstant;
		this.levels = new Uint8Array(analyser.frequencyBinCount);
		this.waveform = new Uint8Array(analyser.fftSize);

		this.context.audioWorklet.addModule('vendor/phase-vocoder.js').then(() => {
			this.phaseVocoderNode = new AudioWorkletNode(this.context, 'phase-vocoder-processor');
			this.gainNode.disconnect();
			this.gainNode.connect(this.phaseVocoderNode);
			this.phaseVocoderNode.connect(this.analyser);
		});
	},

	refreshSource: function () {
		var analyser = this.analyser;
		var data = this.data;

		if (data.buffer && data.src.constructor === String) {
			this.settings = this.el.sceneEl.components['settings'];
			this.getBufferSource().then(source => {
				this.source = source;
				this.source.connect(this.gainNode);

				let originalPlaybackRate = source.customPlaybackRate;
				Object.defineProperty(source, 'customPlaybackRate', {
					get: function () {
						return source.playbackRate.value;
					},
					set: val => {
						const value = parseFloat(val);
						source.playbackRate.value = value;
						if (this.phaseVocoderNode) {
							if (value > 0.001 && this.settings.settings.pitchCorrection) {
								let pitchFactor = 1 / value;

								// Gradually move value closer to target
								const lerp = (start, end, t) => start + (end - start) * t;

								if (value < 0.4) {
									// Lerp value towards 0.5 for slow speeds
									const adjustedValue = lerp(value, 0.4, 0.4);
									pitchFactor = 1 / adjustedValue;
								}
								this.phaseVocoderNode.parameters.get('pitchFactor').value = pitchFactor;
							} else {
								this.phaseVocoderNode.parameters.get('pitchFactor').value = 1;
							}
						}
					},
				});
				source.customPlaybackRate = originalPlaybackRate;
			});

			this.el.sceneEl.addEventListener('settingsChanged', e => {
				let playbackRate = this.source.playbackRate.value;

				if (this.phaseVocoderNode) {
					if (playbackRate > 0.05 && this.settings.settings.pitchCorrection) {
						this.phaseVocoderNode.parameters.get('pitchFactor').value = 1 / playbackRate;
					} else {
						this.phaseVocoderNode.parameters.get('pitchFactor').value = 1;
					}
				}
			});
		} else {
			this.source = this.getMediaSource();
			this.source.connect(this.gainNode);
		}
	},

	suspendContext: function () {
		this.context.suspend();
	},

	resumeContext: function () {
		if (!this.firefoxZeroed) {
			this.context.resume();
		}
	},

	zeroFirefox: function () {
		this.firefoxZeroed = true;
		this.suspendContext();
	},

	unzeroFirefox: function (startPlaying) {
		this.firefoxZeroed = undefined;
		if (startPlaying) {
			this.resumeContext();
		}
	},

	/**
	 * Fetch and parse buffer to audio buffer. Resolve a source.
	 */
	fetchAudioBuffer: function (src) {
		// From cache.
		if (audioBufferCache[src]) {
			if (audioBufferCache[src].constructor === Promise) {
				return audioBufferCache[src];
			} else {
				return Promise.resolve(audioBufferCache[src]);
			}
		}

		if (!this.data.cache) {
			Object.keys(audioBufferCache).forEach(function (src) {
				delete audioBufferCache[src];
			});
		}

		audioBufferCache[src] = new Promise(resolve => {
			// Fetch if does not exist.
			const xhr = (this.xhr = new XMLHttpRequest());
			xhr.open('GET', src);
			xhr.responseType = 'arraybuffer';
			xhr.addEventListener('load', () => {
				// Support Webkit with callback.
				function cb(audioBuffer) {
					audioBufferCache[src] = audioBuffer;
					resolve(audioBuffer);
				}
				const res = this.context[this.data.isSafari ? 'decodeOggData' : 'decodeAudioData'](xhr.response, cb);
				if (res && res.constructor === Promise) {
					res.then(cb).catch(console.error);
				}
			});
			xhr.send();
		});
		return audioBufferCache[src];
	},

	getBufferSource: function () {
		var data = this.data;
		return this.fetchAudioBuffer(data.src)
			.then(() => {
				var source;
				source = this.context.createBufferSource();
				source.buffer = audioBufferCache[data.src];
				this.el.emit('audioanalyserbuffersource', source, false);
				return source;
			})
			.catch(console.error);
	},

	getMediaSource: (function () {
		const nodeCache = {};

		return function () {
			const src = this.data.src.constructor === String ? this.data.src : this.data.src.src;
			if (nodeCache[src]) {
				return nodeCache[src];
			}

			if (this.data.src.constructor === String) {
				this.audio = document.createElement('audio');
				this.audio.crossOrigin = 'anonymous';
				this.audio.setAttribute('src', this.data.src);
			} else {
				this.audio = this.data.src;
			}
			const node = this.context.createMediaElementSource(this.audio);

			nodeCache[src] = node;
			return node;
		};
	})(),
});
