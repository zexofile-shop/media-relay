#!/usr/bin/env bash
# Makes test videos in ./sample_videos (needs ffmpeg). Used by `npm test` and SOURCE=mock.
set -e
cd "$(dirname "$0")/.."
mkdir -p sample_videos
FONT=$(fc-list 2>/dev/null | grep -m1 -i "DejaVuSans.ttf" | cut -d: -f1 || true)
VF="testsrc=size=1280x720:rate=30"
[ -n "$FONT" ] && VF="$VF,drawtext=fontfile=$FONT:text='Sample video  t=%{pts\:hms}  frame %{n}':fontsize=44:fontcolor=white:box=1:boxcolor=0x2563EBcc:x=40:y=h-90"
ffmpeg -nostdin -y -loglevel error -f lavfi -i "$VF" -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 60 \
  -c:v libx264 -preset veryfast -b:v 2600k -minrate 2600k -maxrate 2600k -bufsize 2600k -x264-params nal-hrd=cbr:force-cfr=1 \
  -pix_fmt yuv420p -g 60 -c:a aac -b:a 96k -movflags +faststart sample_videos/lecture_01_sample.mp4
ffmpeg -nostdin -y -loglevel error -i sample_videos/lecture_01_sample.mp4 -t 20 -c copy -f mp4 sample_videos/lecture_02_moov_at_end.mp4
ffmpeg -nostdin -y -loglevel error -ss 5 -i sample_videos/lecture_01_sample.mp4 -frames:v 1 -vf scale=480:-1 sample_videos/lecture_01_sample.jpg
ls -la sample_videos
