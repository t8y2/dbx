use std::sync::atomic::AtomicUsize;

use serde::Serialize;

#[derive(Default, Debug, Serialize)]
#[non_exhaustive]
pub struct Metrics {
    /// Gauge of active connections to the database server, this includes both connections that have belong
    /// to the pool, and connections currently owned by the application.
    pub connection_count: AtomicUsize,
    /// Gauge of active connections that currently belong to the pool.
    pub connections_in_pool: AtomicUsize,
    /// Gauge of active connections that are currently in use by the application (and not in the pool).
    pub connections_in_use: AtomicUsize,
    /// Gauge of GetConn requests that are currently active.
    pub active_wait_requests: AtomicUsize,
    /// Counter of connections that failed to be created.
    pub create_failed: AtomicUsize,
    /// Counter of connections discarded due to pool constraints.
    pub discarded_superfluous_connection: AtomicUsize,
    /// Counter of connections discarded due to being closed upon return to the pool.
    pub discarded_unestablished_connection: AtomicUsize,
    /// Counter of connections that have been returned to the pool dirty that needed to be cleaned
    /// (ie. open transactions, pending queries, etc).
    pub dirty_connection_return: AtomicUsize,
    /// Counter of connections that have been discarded as they were expired by the pool constraints.
    pub discarded_expired_connection: AtomicUsize,
    /// Counter of connections that have been reset.
    pub resetting_connection: AtomicUsize,
    /// Counter of connections that have been discarded as they returned an error during cleanup.
    pub discarded_error_during_cleanup: AtomicUsize,
    /// Counter of connections that have been returned to the pool.
    pub connection_returned_to_pool: AtomicUsize,
    /// Histogram of times connections have spent outside of the pool.
    #[cfg(feature = "hdrhistogram")]
    pub connection_active_duration: MetricsHistogram,
    /// Histogram of times connections have spent inside of the pool.
    #[cfg(feature = "hdrhistogram")]
    pub connection_idle_duration: MetricsHistogram,
    /// Histogram of times connections have spent being checked for health.
    #[cfg(feature = "hdrhistogram")]
    pub check_duration: MetricsHistogram,
    /// Histogram of time spent waiting to connect to the server.
    #[cfg(feature = "hdrhistogram")]
    pub connect_duration: MetricsHistogram,
}

impl Metrics {
    /// Resets all histograms to allow for histograms to be bound to a period of time (ie. between metric scrapes)
    #[cfg(feature = "hdrhistogram")]
    pub fn clear_histograms(&self) {
        self.connection_active_duration.reset();
        self.connection_idle_duration.reset();
        self.check_duration.reset();
        self.connect_duration.reset();
    }
}

#[cfg(feature = "hdrhistogram")]
#[derive(Debug)]
pub struct MetricsHistogram(std::sync::Mutex<hdrhistogram::Histogram<u64>>);

#[cfg(feature = "hdrhistogram")]
impl MetricsHistogram {
    pub fn reset(&self) {
        self.lock().unwrap().reset();
    }
}

#[cfg(feature = "hdrhistogram")]
impl Default for MetricsHistogram {
    fn default() -> Self {
        let hdr = hdrhistogram::Histogram::new(2).unwrap();
        Self(std::sync::Mutex::new(hdr))
    }
}

#[cfg(feature = "hdrhistogram")]
impl Serialize for MetricsHistogram {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let hdr = self.0.lock().unwrap();

        /// A percentile of this histogram - for supporting serializers this
        /// will ignore the key (such as `90%ile`) and instead add a
        /// dimension to the metrics (such as `quantile=0.9`).
        macro_rules! ile {
            ($e:expr) => {
                &MetricAlias(concat!("!|quantile=", $e), hdr.value_at_quantile($e))
            };
        }

        /// A 'qualified' metric name - for supporting serializers such as
        /// serde_prometheus, this will prepend the metric name to this key,
        /// outputting `response_time_count`, for example rather than just
        /// `count`.
        macro_rules! qual {
            ($e:expr) => {
                &MetricAlias("<|", $e)
            };
        }

        use serde::ser::SerializeMap;

        let mut tup = serializer.serialize_map(Some(10))?;
        tup.serialize_entry("samples", qual!(hdr.len()))?;
        tup.serialize_entry("min", qual!(hdr.min()))?;
        tup.serialize_entry("max", qual!(hdr.max()))?;
        tup.serialize_entry("mean", qual!(hdr.mean()))?;
        tup.serialize_entry("stdev", qual!(hdr.stdev()))?;
        tup.serialize_entry("90%ile", ile!(0.9))?;
        tup.serialize_entry("95%ile", ile!(0.95))?;
        tup.serialize_entry("99%ile", ile!(0.99))?;
        tup.serialize_entry("99.9%ile", ile!(0.999))?;
        tup.serialize_entry("99.99%ile", ile!(0.9999))?;
        tup.end()
    }
}

/// This is a mocked 'newtype' (eg. `A(u64)`) that instead allows us to
/// define our own type name that doesn't have to abide by Rust's constraints
/// on type names. This allows us to do some manipulation of our metrics,
/// allowing us to add dimensionality to our metrics via key=value pairs, or
/// key manipulation on serializers that support it.
#[cfg(feature = "hdrhistogram")]
struct MetricAlias<T: Serialize>(&'static str, T);

#[cfg(feature = "hdrhistogram")]
impl<T: Serialize> Serialize for MetricAlias<T> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_newtype_struct(self.0, &self.1)
    }
}

#[cfg(feature = "hdrhistogram")]
impl std::ops::Deref for MetricsHistogram {
    type Target = std::sync::Mutex<hdrhistogram::Histogram<u64>>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
