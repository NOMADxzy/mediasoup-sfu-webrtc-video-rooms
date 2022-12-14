const express = require('express')

const app = express()
const https = require('httpolyglot')
const fs = require('fs')
const mediasoup = require('mediasoup')
const config = require('./config')
const path = require('path')
const Room = require('./Room')
const Peer = require('./Peer')

const spawn = require('child_process').spawn;
const options = {
  key: fs.readFileSync(path.join(__dirname, config.sslKey), 'utf-8'),
  cert: fs.readFileSync(path.join(__dirname, config.sslCrt), 'utf-8')
}

const httpsServer = https.createServer(options, app)
const io = require('socket.io')(httpsServer)

app.use(express.static(path.join(__dirname, '..', 'public')))
app.get("/roomlist", (req,res)=>{
  res.json(roomList)
})

httpsServer.listen(config.listenPort, () => {
  console.log('Listening on https://' + config.listenIp + ':' + config.listenPort)
})

// all mediasoup workers
let workers = []
let nextMediasoupWorkerIdx = 0

/**
 * roomList
 * {
 *  room_id: Room {
 *      id:
 *      router:
 *      peers: {
 *          id:,
 *          name:,
 *          master: [boolean],
 *          transports: [Map],
 *          producers: [Map],
 *          consumers: [Map],
 *          rtpCapabilities:
 *      }
 *  }
 * }
 */
let roomList = new Map()

;(async () => {
  await createWorkers()
})()

async function createWorkers() {
  let { numWorkers } = config.mediasoup

  for (let i = 0; i < numWorkers; i++) {
    let worker = await mediasoup.createWorker({
      logLevel: config.mediasoup.worker.logLevel,
      logTags: config.mediasoup.worker.logTags,
      rtcMinPort: config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: config.mediasoup.worker.rtcMaxPort
    })

    worker.on('died', () => {
      console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid)
      setTimeout(() => process.exit(1), 2000)
    })
    workers.push(worker)

    // log worker resource usage
    /*setInterval(async () => {
            const usage = await worker.getResourceUsage();

            console.info('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage);
        }, 120000);*/
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', async ({ room_id }, callback) => {
    if (roomList.has(room_id)) {
      callback('already exists')
    } else {
      console.log('Created room', { room_id: room_id })
      let worker = await getMediasoupWorker()
      roomList.set(room_id, new Room(room_id, worker, io))
      callback(room_id)
    }
  })

  socket.on('join', ({ room_id, name }, cb) => {
    console.log('User joined', {
      room_id: room_id,
      name: name
    })

    if (!roomList.has(room_id)) {
      return cb({
        error: 'Room does not exist'
      })
    }

    roomList.get(room_id).addPeer(new Peer(socket.id, name))
    socket.room_id = room_id

    cb(roomList.get(room_id).toJson())
  })

  socket.on('getProducers', () => {
    if (!roomList.has(socket.room_id)) return
    console.log('Get producers', { name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}` })

    // send all the current producer to newly joined member
    let producerList = roomList.get(socket.room_id).getProducerListForPeer()
    socket.emit('newProducers', producerList)
  })

  socket.on('getRouterRtpCapabilities', (_, callback) => {
    console.log('Get RouterRtpCapabilities', {
      name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`
    })

    try {
      callback(roomList.get(socket.room_id).getRtpCapabilities())
    } catch (e) {
      callback({
        error: e.message
      })
    }
  })

  socket.on('createWebRtcTransport', async (_, callback) => {
    console.log('Create webrtc transport', {
      name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`
    })

    try {
      const { params } = await roomList.get(socket.room_id).createWebRtcTransport(socket.id)
      // const { params } = await roomList.get(socket.room_id).createPlainTransport({socket_id:socket.id})
      callback(params)
    } catch (err) {
      console.error(err)
      callback({
        error: err.message
      })
    }
  })
  socket.on("createBroadCaster", async (_,callback)=>{
    try {
      const room = roomList.get(socket.room_id);
      let creator = room.getPeers().get(socket.id).name
      const bc_id = await room.createBroadcaster("broad1",creator);

      callback({broadcaster_id:bc_id})
  } catch (err) {
    console.log(err);
    callback({
      error: err.message
    })
  }
  })

  socket.on("createBroadCasterProducer", async (_,callback)=>{
    const room = roomList.get(socket.room_id);
    let broadcaster = room.broadcasters.get(_.bc_id)

    let VIDEO_PT = 101
    let VIDEO_SSRC = 2222
    let AUDIO_SSRC = 1111
    let AUDIO_PT=100
    let kind = "video"

    let vid_rtpParameters = {
      "codecs": [
        { "mimeType":"video/vp8", "payloadType":VIDEO_PT, "clockRate":90000 }],
      "encodings": [{ "ssrc":VIDEO_SSRC }] }
    let aud_rtpParameters = {
      "codecs": [
          { "mimeType":"audio/opus", "payloadType":AUDIO_PT, "clockRate":48000, "channels":2, "parameters":{ "sprop-stereo":1 } }],
      "encodings": [{ "ssrc":AUDIO_SSRC }] }

    let res1 = await room.createPlainTransport(socket.id)
    // console.log("video transport params",res1.params)
    broadcaster.transports.set(res1.params.id,res1.transport)
    let rtpParameters = vid_rtpParameters
    const vid_producer = await res1.transport.produce({kind, rtpParameters})
    broadcaster.producers.set(vid_producer.id,vid_producer)

    let res2 = await room.createPlainTransport(socket.id)
    // console.log("audio transport params",res2.params)
    broadcaster.transports.set(res2.params.id,res2.transport)
    rtpParameters = aud_rtpParameters
    kind = "audio"
    const aud_producer = await res2.transport.produce({kind, rtpParameters})
    broadcaster.producers.set(aud_producer.id,aud_producer)

    room.broadCast(null, 'newProducers', [
          {
            producer_id: vid_producer.id,
            producer_socket_id: socket.id
          },
          {
            producer_id: aud_producer.id,
            producer_socket_id: socket.id
          }
        ])

    let params = ['broad.sh',res1.params.ip,res1.params.port,res1.params.rtcpPort,res2.params.ip,res2.params.port,res2.params.rtcpPort];
    console.log("bash params: ",params)
    spawn('bash', params).unref();
      })

  socket.on('shareProducer', async (_,callback) => {
    let listenIp = "10.128.161.59";
    const room1 = roomList.get(socket.room_id)

    let producerId = _.pid;
    const room2 = roomList.get(_.rid)
    let router = room2.router;

    // const transport = await room.router.createPipeTransport({listenIp})
    let res = await room1.router.pipeToRouter({producerId,router});
    callback(res)//???pipetransport?????????producer???consumer??????????????????

    room2.broadCast(null,"newProducers",[{//????????????????????????producer
      producer_id: producerId,
      producer_socket_id: socket.id
    }])
  })


  socket.on('connectTransport', async ({ transport_id, dtlsParameters }, callback) => {
    console.log('Connect transport', { name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}` })

    if (!roomList.has(socket.room_id)) return
    await roomList.get(socket.room_id).connectPeerTransport(socket.id, transport_id, dtlsParameters)

    callback('success')
  })

  socket.on('produce', async ({ kind, rtpParameters, producerTransportId }, callback) => {
    if (!roomList.has(socket.room_id)) {
      return callback({ error: 'not is a room' })
    }

    let producer_id = await roomList.get(socket.room_id).produce(socket.id, producerTransportId, rtpParameters, kind)

    console.log('Produce', {
      type: `${kind}`,
      name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`,
      id: `${producer_id}`
    })

    callback({
      producer_id
    })
  })

  socket.on('consume', async ({ consumerTransportId, producerId, rtpCapabilities }, callback) => {
    //TODO null handling
    let params = await roomList.get(socket.room_id).consume(socket.id, consumerTransportId, producerId, rtpCapabilities)

    console.log('Consuming', {
      name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`,
      producer_id: `${producerId}`,
      consumer_id: `${params.id}`
    })

    callback(params)
  })

  socket.on('resume', async (data, callback) => {
    await consumer.resume()
    callback()
  })

  socket.on('getMyRoomInfo', (_, cb) => {
    cb(roomList.get(socket.room_id).toJson())
  })
  socket.on('msg', (msg, cb) => {
    console.log(msg)
    // console.log(roomList.get(socket.room_id))
    console.log(socket)
    roomList.get(socket.room_id).broadCast(socket.id, 'msg',
        [socket.name,msg])
  })
  socket.on('fileshare', (src, cb) => {
    console.log("fileshare")
  })

  socket.on('disconnect', () => {
    console.log('Disconnect', {
      name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
    })

    if (!socket.room_id) return
    roomList.get(socket.room_id).removePeer(socket.id)
  })

  socket.on('producerClosed', ({ producer_id }) => {
    console.log('Producer close', {
      name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
    })

    roomList.get(socket.room_id).closeProducer(socket.id, producer_id)
  })

  socket.on('exitRoom', async (_, callback) => {
    console.log('Exit room', {
      name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
    })

    if (!roomList.has(socket.room_id)) {
      callback({
        error: 'not currently in a room'
      })
      return
    }
    // close transports
    await roomList.get(socket.room_id).removePeer(socket.id)
    if (roomList.get(socket.room_id).getPeers().size === 0) {
      roomList.delete(socket.room_id)
    }

    socket.room_id = null

    callback('successfully exited room')
  })
})

// TODO remove - never used?
function room() {
  return Object.values(roomList).map((r) => {
    return {
      router: r.router.id,
      peers: Object.values(r.peers).map((p) => {
        return {
          name: p.name
        }
      }),
      id: r.id
    }
  })
}

/**
 * Get next mediasoup Worker.
 */
function getMediasoupWorker() {
  const worker = workers[nextMediasoupWorkerIdx]

  if (++nextMediasoupWorkerIdx === workers.length) nextMediasoupWorkerIdx = 0

  return worker
}
