import React, { useEffect, useRef, useState } from "react";
import { Mic, Square, X } from "lucide-react";
import { integrationRequest } from "../../integrations.tsx";
import "./conversation-integrations.css";

const durationSeconds = 30;

async function wave(chunks: Blob[], mimeType: string) {
  const audio = new AudioContext();
  try {
    const decoded = await audio.decodeAudioData(
      await new Blob(chunks, { type: mimeType }).arrayBuffer(),
    );
    const sampleRate = 16_000;
    const samples = Math.min(
      Math.ceil(decoded.duration * sampleRate),
      durationSeconds * sampleRate,
    );
    const render = new OfflineAudioContext(1, samples, sampleRate);
    const source = render.createBufferSource();
    source.buffer = decoded;
    source.connect(render.destination);
    source.start();
    const mono = (await render.startRendering()).getChannelData(0);
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const tag = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++)
        view.setUint8(offset + i, value.charCodeAt(i));
    };
    tag(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    tag(8, "WAVE");
    tag(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    tag(36, "data");
    view.setUint32(40, samples * 2, true);
    const pcm = new DataView(new ArrayBuffer(samples * 2));
    for (let i = 0; i < mono.length; i++)
      pcm.setInt16(
        i * 2,
        Math.round(Math.max(-1, Math.min(1, mono[i])) * 32_767),
        true,
      );
    return new Blob([header, pcm.buffer], { type: "audio/wav" });
  } finally {
    await audio.close();
  }
}

interface Recording {
  abort: AbortController;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: ReturnType<typeof setTimeout>;
}

function release(recording: Recording) {
  clearTimeout(recording.timer);
  for (const track of recording.stream?.getTracks() ?? []) track.stop();
}

export function VoiceInput({
  endpoint,
  onText,
}: {
  endpoint: string;
  onText: (text: string) => void;
}) {
  const active = useRef<Recording>(undefined);
  const insertText = useRef(onText);
  const [state, setState] = useState<
    "idle" | "starting" | "recording" | "transcribing"
  >("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    insertText.current = onText;
  }, [onText]);

  useEffect(
    () => () => {
      if (active.current) {
        active.current.abort.abort();
        release(active.current);
      }
    },
    [],
  );

  function cancel() {
    const current = active.current;
    if (!current) return;
    current.abort.abort();
    release(current);
    active.current = undefined;
    setState("idle");
  }

  async function start() {
    if (active.current) return;
    const current: Recording = { abort: new AbortController() };
    const signal = current.abort.signal;
    active.current = current;
    setState("starting");
    setMessage("");
    const finish = () => {
      release(current);
      if (active.current === current) {
        active.current = undefined;
        setState("idle");
      }
    };
    try {
      const { phase } = await integrationRequest<{ phase: string }>(
        endpoint,
        "/voice",
        { signal },
      );
      if (!["ready", "standby", "waking"].includes(phase))
        throw new Error("请先在「设置 → 功能开关」准备 SenseVoice 模型。");
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error("当前环境无法访问麦克风。");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      current.stream = stream;
      signal.throwIfAborted();
      const recorder = new MediaRecorder(stream);
      current.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (!signal.aborted && event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener(
        "error",
        () => {
          if (!signal.aborted) setMessage("录音未完成，请检查麦克风权限。");
          current.abort.abort();
          finish();
        },
        { once: true },
      );
      recorder.addEventListener(
        "stop",
        () => {
          release(current);
          if (signal.aborted) return;
          setState("transcribing");
          void (async () => {
            try {
              const audio = await wave(chunks, recorder.mimeType);
              signal.throwIfAborted();
              const { text } = await integrationRequest<{ text: string }>(
                endpoint,
                "/voice/transcribe",
                {
                  method: "POST",
                  headers: { "Content-Type": "audio/wav" },
                  body: audio,
                  signal,
                },
              );
              signal.throwIfAborted();
              if (text.trim()) insertText.current(text.trim());
              else setMessage("没有识别到语音。");
            } catch (error) {
              if (!signal.aborted)
                setMessage(
                  error instanceof Error ? error.message : "语音识别未完成。",
                );
            } finally {
              finish();
            }
          })();
        },
        { once: true },
      );
      recorder.start();
      current.timer = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, durationSeconds * 1000);
      setState("recording");
    } catch (error) {
      if (!signal.aborted)
        setMessage(error instanceof Error ? error.message : "无法开始录音。");
      finish();
    }
  }

  const label =
    state === "recording"
      ? "结束录音并识别"
      : state === "transcribing"
        ? "取消语音识别"
        : state === "starting"
          ? "取消开启麦克风"
          : "开始语音输入";
  return (
    <>
      <button
        className="icon-control"
        type="button"
        aria-label={label}
        title={label}
        onClick={() => {
          if (state === "recording") {
            const recorder = active.current?.recorder;
            if (recorder?.state === "recording") recorder.stop();
          } else if (state === "idle") void start();
          else cancel();
        }}
      >
        {state === "recording" ? (
          <Square size={15} />
        ) : state === "idle" ? (
          <Mic size={16} />
        ) : (
          <X size={16} />
        )}
      </button>
      {message || state === "transcribing" ? (
        <span className="voice-input-message" role="status">
          {message || "正在识别…"}
        </span>
      ) : null}
    </>
  );
}
