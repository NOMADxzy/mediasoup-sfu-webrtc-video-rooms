#rm -rf "${1}"

videoTransportIp=$1
videoTransportPort=$2
videoTransportRtcpPort=$3

audioTransportIp=$4
audioTransportPort=$5
audioTransportRtcpPort=$6

mkdir "${videoTransportRtcpPort}"
mkdir "${audioTransportPort}"