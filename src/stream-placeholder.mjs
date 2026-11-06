// A stand-in first picture for /stream when a camera has no kept live keyframe yet (never watched here).
//
// Instant start (stream-primer.mjs) answers /stream with the camera's last live keyframe, so Home Assistant's
// go2rtc gets its RTSP DESCRIBE reply within its fixed 5 s while a battery camera wakes. A camera nobody has
// watched through this bridge has no such keyframe, and its first live view timed out before the camera
// answered. This keyframe fills that gap: one H.264 IDR (640x360, baseline, SPS+PPS in band, so it decodes on
// its own) showing a dark screen with "Waking up the camera…". Generated once with:
//
//   ffmpeg -f lavfi -i "color=c=0x1c1c1c:s=640x360:d=1" \
//     -vf "drawtext=text='Waking up the camera…':fontcolor=0xbbbbbb:fontsize=28:x=(w-text_w)/2:y=(h-text_h)/2" \
//     -frames:v 1 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -x264-params keyint=1:repeat-headers=1 \
//     -bsf:v h264_mp4toannexb -f h264 placeholder.h264
//
// It is H.264 only: a camera whose live feed turns out to be H.265 cannot follow it in the same stream (the
// consumer's ffmpeg fixed its codec on the placeholder), so the route ends that response once the first live
// keyframe is kept, and the reconnect is primed with the right codec.
export const PLACEHOLDER_KEYFRAME = Buffer.from(
  [
    "AAAAAWdCwB7cCgL/lwEQAAADABAAAAMDIPFi+AAAAAFozg8sgAAAAQYF//9b3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2",
    "NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cu",
    "dmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MTow",
    "eDExMSBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9t",
    "ZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0t",
    "MiB0aHJlYWRzPTExIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNl",
    "ZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTEga2V5aW50",
    "X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0cmVlPTAgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1p",
    "bj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAFliIQEvJigADNPJycnJycnJycnJycnJycn",
    "JycnJycnJycnJycnJycnJycnJycnJycnXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "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",
    "kmsAqH/6h+CApaoADbyMGVEHaWeOGMNQS1111111111111111111111/0j/w+CCBjSZwThcIvNf3z//CRFQLypMQA8v/gRg978/v",
    "fUEv6N/8PgiABeE82osq/pz1jWtmNSGJvDJBGGuuuuuu+++uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
    "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
    "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
    "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
    "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuvA",
  ].join(""),
  "base64",
);
export const PLACEHOLDER_CODEC = "h264";
