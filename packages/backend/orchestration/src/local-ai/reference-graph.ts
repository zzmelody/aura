import type { Graph } from "./graphs.ts";
import type { VideoInput } from "./api.ts";

/** Native Ref2VA graph matching the locally validated MiniMax H3 deployment. */
export function referenceGraph(
  input: VideoInput & {
    width: number;
    height: number;
    frames: number;
    seed: number;
  },
  previous?: string,
): Graph {
  const graph: Graph = {
    "1": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        weight_dtype: "default",
      },
    },
    "22": {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["1", 0],
        lora_name: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
        strength_model: 1,
      },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        type: "minimax",
        device: "default",
      },
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" },
    },
    "4": {
      class_type: "VAELoader",
      inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" },
    },
    "7": {
      class_type: "MiniMaxH3ReferenceToVideo",
      inputs: {
        clip: ["2", 0],
        vae: ["3", 0],
        prompt: `${input.referenceVideo ? `Use <Video 1> for ${input.referenceVideo.role}.\n` : ""}${input.prompt}${previous ? "\nContinue from the anchored first frame; preserve subjects, setting and ongoing motion." : ""}`,
        width: input.width,
        height: input.height,
        length: input.frames,
        ref_image_size: "match",
      },
    },
    "8": { class_type: "RandomNoise", inputs: { noise_seed: input.seed } },
    "9": {
      class_type: "KSamplerSelect",
      inputs: { sampler_name: "res_multistep" },
    },
    "10": {
      class_type: "BasicScheduler",
      inputs: { model: ["22", 0], scheduler: "simple", steps: 4, denoise: 1 },
    },
    "11": {
      class_type: "BasicGuider",
      inputs: { model: ["22", 0], conditioning: [previous ? "24" : "7", 0] },
    },
    "12": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["8", 0],
        guider: ["11", 0],
        sampler: ["9", 0],
        sigmas: ["10", 0],
        latent_image: ["7", 1],
      },
    },
    "13": {
      class_type: "VAEDecodeTiled",
      inputs: {
        samples: ["12", 0],
        vae: ["3", 0],
        tile_size: 256,
        overlap: 64,
        temporal_size: 64,
        temporal_overlap: 8,
      },
    },
    "14": {
      class_type: "VAEDecodeAudio",
      inputs: { samples: ["12", 0], vae: ["4", 0] },
    },
    "15": {
      class_type: "CreateVideo",
      inputs: { images: ["13", 0], audio: ["14", 0], fps: 24 },
    },
    "16": {
      class_type: "SaveVideo",
      inputs: {
        video: ["15", 0],
        filename_prefix: "video/reference",
        format: "mp4",
        codec: "h264",
      },
    },
  };
  if (input.referenceVideo) {
    graph["5"] = { class_type: "LoadVideo", inputs: { file: "" } };
    graph["6"] = {
      class_type: "GetVideoComponents",
      inputs: { video: ["5", 0] },
    };
    graph["7"].inputs["ref_videos.ref_video_0"] = ["6", 0];
    if (input.referenceVideo.audio) {
      graph["7"].inputs.audio_vae = ["4", 0];
      graph["7"].inputs["ref_video_audios.ref_video_audio_0"] = ["6", 1];
    }
  }
  for (const [i] of (input.referenceImages ?? []).entries()) {
    graph[String(100 + i)] = { class_type: "LoadImage", inputs: { image: "" } };
    graph["7"].inputs[`ref_images.ref_image_${i}`] = [String(100 + i), 0];
  }
  if (previous) {
    graph["23"] = { class_type: "LoadImage", inputs: { image: "" } };
    graph["24"] = {
      class_type: "MiniMaxH3AddGuide",
      inputs: {
        positive: ["7", 0],
        latent: ["7", 1],
        vae: ["3", 0],
        image: ["23", 0],
        frame_idx: 0,
      },
    };
  }
  return graph;
}
