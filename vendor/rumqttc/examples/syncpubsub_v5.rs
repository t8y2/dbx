use rumqttc::v5::mqttbytes::{v5::LastWill, QoS};
use rumqttc::v5::{Client, ConnectionError, MqttOptions};
use std::thread;
use std::time::Duration;

fn main() {
    pretty_env_logger::init();

    let mut mqttoptions = MqttOptions::new("test-1", "localhost", 1884);
    let will = LastWill::new("hello/world", "good bye", QoS::AtMostOnce, false, None);
    mqttoptions
        .set_keep_alive(Duration::from_secs(5))
        .set_last_will(will);

    let (client, mut connection) = Client::new(mqttoptions, 10);
    thread::spawn(move || publish(client));

    for (i, notification) in connection.iter().enumerate() {
        match notification {
            Err(ConnectionError::Io(error))
                if error.kind() == std::io::ErrorKind::ConnectionRefused =>
            {
                println!("Failed to connect to the server. Make sure correct client is configured properly!\nError: {error:?}");
                return;
            }
            _ => {}
        }
        println!("{i}. Notification = {notification:?}");
    }

    println!("Done with the stream!!");
}

fn publish(client: Client) {
    client.subscribe("hello/+/world", QoS::AtMostOnce).unwrap();
    for i in 0..10_usize {
        let payload = vec![1; i];
        let topic = format!("hello/{i}/world");
        let qos = QoS::AtLeastOnce;

        let _ = client.publish(topic, qos, true, payload);
    }

    thread::sleep(Duration::from_secs(1));
}
