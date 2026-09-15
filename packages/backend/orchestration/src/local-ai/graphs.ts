export type Graph = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;
export function imageGraph(
  input: {
    prompt: string;
    negative: string;
    width: number;
    height: number;
    steps: number;
    cfg: number;
    seed: number;
  },
  prefix: string,
): Graph {
  return {
    "1": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "qwen_image_2512_fp8_e4m3fn.safetensors",
        weight_dtype: "default",
      },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
        type: "qwen_image",
        device: "default",
      },
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: "qwen_image_vae.safetensors" },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: input.prompt, clip: ["2", 0] },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: input.negative, clip: ["2", 0] },
    },
    "6": {
      class_type: "ModelSamplingAuraFlow",
      inputs: { model: ["1", 0], shift: 3.1 },
    },
    "7": {
      class_type: "EmptySD3LatentImage",
      inputs: { width: input.width, height: input.height, batch_size: 1 },
    },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: ["6", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["7", 0],
        seed: input.seed,
        steps: input.steps,
        cfg: input.cfg,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
      },
    },
    "9": {
      class_type: "VAEDecode",
      inputs: { samples: ["8", 0], vae: ["3", 0] },
    },
    "10": {
      class_type: "SaveImage",
      inputs: { images: ["9", 0], filename_prefix: prefix },
    },
  };
}

export function videoGraph(
  input: {
    prompt: string;
    width: number;
    height: number;
    frames: number;
    seed: number;
  },
  prefix: string,
): Graph {
  return {
    "1": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        weight_dtype: "default",
      },
    },
    "2": {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["1", 0],
        lora_name: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
        strength_model: 1,
      },
    },
    "3": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        type: "minimax",
        device: "default",
      },
    },
    "4": {
      class_type: "VAELoader",
      inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" },
    },
    "5": {
      class_type: "VAELoader",
      inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" },
    },
    "6": {
      class_type: "MiniMaxH3ImageToVideo",
      inputs: {
        clip: ["3", 0],
        vae: ["4", 0],
        prompt: input.prompt,
        width: input.width,
        height: input.height,
        length: input.frames,
      },
    },
    "7": { class_type: "RandomNoise", inputs: { noise_seed: input.seed } },
    "8": {
      class_type: "KSamplerSelect",
      inputs: { sampler_name: "res_multistep" },
    },
    "9": {
      class_type: "BasicScheduler",
      inputs: { model: ["2", 0], scheduler: "simple", steps: 8, denoise: 1 },
    },
    "10": {
      class_type: "BasicGuider",
      inputs: { model: ["2", 0], conditioning: ["6", 0] },
    },
    "11": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["7", 0],
        guider: ["10", 0],
        sigmas: ["9", 0],
        sampler: ["8", 0],
        latent_image: ["6", 1],
      },
    },
    "12": {
      class_type: "VAEDecode",
      inputs: { samples: ["11", 0], vae: ["4", 0] },
    },
    "13": {
      class_type: "VAEDecodeAudio",
      inputs: { samples: ["11", 0], vae: ["5", 0] },
    },
    "14": {
      class_type: "CreateVideo",
      inputs: { images: ["12", 0], audio: ["13", 0], fps: 24 },
    },
    "15": {
      class_type: "SaveVideo",
      inputs: {
        video: ["14", 0],
        filename_prefix: prefix,
        format: "auto",
        codec: "auto",
      },
    },
  };
}
