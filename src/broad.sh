AUDIO_SSRC=1111
AUDIO_PT=100
VIDEO_SSRC=2222
VIDEO_PT=101

videoTransportIp=$1
videoTransportPort=$2
videoTransportRtcpPort=$3

audioTransportIp=$4
audioTransportPort=$5
audioTransportRtcpPort=$6

MEDIA_FILE='./oceans.mp4'


ffmpeg \
	-re \
	-v info \
	-stream_loop -1 \
	-i ${MEDIA_FILE} \
	-map 0:a:0 \
	-acodec libopus -ab 128k -ac 2 -ar 48000 \
	-map 0:v:0 \
	-pix_fmt yuv420p -c:v libvpx -b:v 1000k -deadline realtime -cpu-used 4 \
	-f tee \
	"[select=a:f=rtp:ssrc=${AUDIO_SSRC}:payload_type=${AUDIO_PT}]rtp://${audioTransportIp}:${audioTransportPort}?rtcpport=${audioTransportRtcpPort}|[select=v:f=rtp:ssrc=${VIDEO_SSRC}:payload_type=${VIDEO_PT}]rtp://${videoTransportIp}:${videoTransportPort}?rtcpport=${videoTransportRtcpPort}"