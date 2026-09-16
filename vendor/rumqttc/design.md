-[ ] Make core publish take qos with publish
-[ ] Rust iterator like design
-[ ] Should the APIs take files directly

This doc is a journal. Make a blog out of this

Primarily designed to efficiently perform streaming (unbounded) mqtt publishes and
subscriptions in flaky networks.

But the design choices to take a `Stream` for user requests (publishes, subscriptions etc) and the
eventloop it self being a `Stream` yielding incoming packets to the user makes other use cases easy to implement.


With out boring myself and you with only details, let's try to dive in
with some real world use cases


##### Robustness (reconnections and retransmissions)
------



##### Pausing the network activity to cooperate with other processes which needs bandwidth
------



##### Shutting down the eventloop by saving current state to the disk
------



##### Disk aware request stream
------




##### Bounded requests
------






* Automatic reconnections
* No commands for misc operations like network pause/
Connection and Automatic reconnections
-------

Open question: When should event loop start taking control of reconnections? After initial success or should
we expose options similar to current implementation? what should be the default behavior


```
Reconnect::AfterFirstSuccess
Reconnect::Always
Reconnect::Never
```

Let's do this for starters

```$xslt
    // create an eventloop after the initial mqtt connection is successful
    // user will decide if this should be retried or not
    let eventloop = connect(mqttoptions) -> Result<EventLoop, Error>

    // during intermittent reconnetions due to bad network, eventloop will
    // behave as per configured reconnection options to the eventloop
    let stream = eventloop.assemble(reconnection_options, inputs);
```

Possible reconnection options

```$xslt
Reconnect::Never
Reconnect::Automatic
```

I feel this a good middle ground between manual user control and rumq being very opinionated about
reconnection behaviour.

But why not leave the intermittent reconnection behaviour as well to the user you ask?

Because maintaini
state is a much more complicated business than just retrying the connection. We don't want the user to think
about mqttstate by default. If the user intends for a much more custom behaviour, he/she can use
`Reconnect::Never` and pass the returned `MqttState` to the next connection.

Takes any stream type as input
-------

Allows eventloop to be channel implementation agnostic. This opens up interesting usage patterns. Instead of providing
methods to communicate with the eventloop over a channel, we can directly communicate with th eventloop over the specified stream. Users can customize the stream in any way that fits their usecase. For example we plugin streams which orchestrate data between
disk and memory.

This strategy prevents resource overhead in cases where user uses a different kind of channel than what rumqtt uses. E.g if
rumqtt uses futures channnel and user wants to plugin data coming from different kind of stream, user has to make extra copies
passing data fromn the channel of his choice to futures channel (requires user to run an extra thread which does the handover)

```
// thread 1
user_channel_tx.send(data)

// thread 2
data = user_channel_rx.recv();
rumqtt_channel_tx.send(data);

// thread 3
rumqtt_eventloop.start(rumqtt_channel_rx);
```

vs

```
// thread 1
user_channel_tx.send(data)

// thread 2
rumqtt_eventloop.start(user_channel_rx_stream);
```


Don't spawn any thread from the library
-------

Provide all the eventloop handling necessary for a robust mqtt connection but don't spawn any inner threads. This choice is
left to the user. Usecases might vary from running streams with fixed input to channels that keep producing data forever

```
let stream = vec![publish1, publish2, publish3];
let eventloop = MqttEventLoop::new(options);
eventloop.run(stream);
```

or

```
let (tx, rx) = channel::bound(10);

thread::spawn(move || loop {
    tx.send(publish);
    sleep(1)
});

let eventloop = MqttEventLoop::new(options);
eventloop.run(rx);
```


Support both synchronous and asynchronous use cases
-------

Leverage on the above pattern to support both synchronous and asynchronus publishes with timeouts

```
let publishes = [p1, p2, p3];
eventloop.run_timeout(publishes, 10 * Duration::SECS);
```

Eventloop will wait for all the acks within timeout (where ever necessary) and exits


Command channels to configure eventloop dynamically
-------

reconnections, disconnection, throttle speed, pause/resume (without disconnections)


#### shutdown, disconnection, reconnection, pause/resume semantics

there might be no need to implement separate shutdown to stop the eventloop and return existing state

```
let eventloop = MqttEventloop::new();

thread::spawn(|| {
    command.shutdown()
})

enum EventloopStatus  {
    Shutdown(MqttState)
    // sends disconnect to the server and waits for server server disconnection
    // should't process any new data from the user channel
    Disconnect
}

eventloop.run() //return -> Result<MqttSt>
```


Keep additional functionality like gcloud jwt auth out of rumqtt
-------

Prevents (some) conflicts w.r.t different versions of ring. conflicts because of rustls are still possible but atleast
prevents ones w.r.t jsonwebtoken.

Keeps the codebase small which eases some maintainence burden

Keep alive
-------

Keepalives can be a little tricky

client should keep track of keepalive timeouts for 2 different reasons

* when there is no incoming n/w activity

to detect any halfopen connections to the broker, client should send a pingrequest packet
and validate next pingreq with previous pingresp.
if previous ack isn't received, client should consider this as a halfopen connection and
disconnect. takes 2 keepalive times to detect halfopen connection and disconnect

* to prevent broker from disconnecting the client due to no client activity

broker should receive some packet activity from a client or else it'll assume the
connection as halfopen and disconnect.
for this reason, even though the client is receiving some incoming packets(qos0 publishes)
client should timeout when there is no outgoing packet activity and send a ping request


We would require timeouts on network incoming packets as well as network outgoing packets. concurrently

so we need to create 2 streams with timeouts, one on n/w incoming packets and another on n/w outgoing packets and select

```rust
let incoming_stream = stream!(tcp.read_mqtt().timeout(NetworkTimeout))

This captures incoming stream timeout

Caputuring timeout on outgoing packects (replys due to incoming packets + user requests) is tricky because replys
are a sideeffect of processing incoming packets which generate notifications for the user as well.
To have a timeout on a combination of reply and requests, we need to filter out notifications (or put it into other stream)
which beats our design of returning one eventloop stream to the user to handle full mqtt io


let mqtt_stream = stream! {
    loop {
        select! {
            (notification, reply) = incoming_stream.next().handle_incoming_packet(),
            (request) = requests.next()
        }
        yield reply
    }
}
```

So there is no way to separate notifications from reply without creating a duplicate stream

Option 2 is to timeout on user requests alone. This will lead to sending unnecessary pingreqests after keep alive time
even when there is outgoing network activity due to network replys. But this will let us have one simple
stream to poll. Returning 2 streams might not be intuitive to the users. main eventloop progress can stop when the user
doensn't poll the notification stream (tx.send will block which eventually blocks all incoming packets). Having a second stream also results in more allocations in the hotpath (which might not be a big deal but not ideal)
Option2 is also considerable less codebase and hence easy maintainence.

Keep alive take 2

Ok, creating independent timeout streams on network and request streams makes keep alive complicated. Both the streams mutating a common timeout is the solution

* When there is an incoming packet which replys the network with some packet, reset the timer and don't generate `PingReq`
* When there are no incoming and outgoing packets, timeout, hence generate `PingReq`. Reset the delay
* In a keep alive window, when there is an incoming packet (which doesn't trigger a reply), mark it
* When there is an outgoing request in this window with incoming already marked. Reset the timer.
* If there is no outgoing request in this window, timeout, hence generate `PingReq`. Reset the delay and markers


Timeout for packets which are not acked
------------------

Implement timeout for unacked packets and drop/republish them. Useful if the
broker is buggy. But might not be too important as unacked messages are
anyway retried during reconnection
