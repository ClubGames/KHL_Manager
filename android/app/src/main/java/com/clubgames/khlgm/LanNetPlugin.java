package com.clubgames.khlgm;

import android.content.Context;
import android.net.wifi.WifiManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Online over the local network, the Android app's side (the page's side is src/net/lan.ts; the Windows app's is
 * desktop/lan.cjs — the three speak the same protocol, so a phone plays a computer). A page in a WebView can neither
 * listen for connections nor broadcast, so the sockets are here:
 * <ul>
 * <li>host: a TCP server on port 47810 (the next free one up to 47815) for one guest at a time, and a UDP broadcast
 * «a game is here» once a second to every local network (Wi-Fi, the phone's own hotspot) on port 47811;</li>
 * <li>join: a TCP connection to the host's address;</li>
 * <li>messages: one JSON object per line (UTF-8), handed to the page as they are;</li>
 * <li>scan: listens for the hosts' broadcasts (with a multicast lock: many phones drop broadcasts without one).</li>
 * </ul>
 * Everything comes to the page as one event, "net": {type: peer | message | closed | found, …}.
 */
@CapacitorPlugin(name = "LanNet")
public class LanNetPlugin extends Plugin {
    private ServerSocket server;
    private Socket sock;
    private Writer out;
    private final ExecutorService writer = Executors.newSingleThreadExecutor();
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private volatile String beaconText = "";
    private volatile int beaconPort = 47811;
    private DatagramSocket beaconSock;
    private ScheduledFuture<?> beaconTask;
    private DatagramSocket scanSock;
    private WifiManager.MulticastLock lock;

    private void emit(String type, String key, String value, String key2, String value2) {
        JSObject e = new JSObject();
        e.put("type", type);
        if (key != null) e.put(key, value);
        if (key2 != null) e.put(key2, value2);
        notifyListeners("net", e);
    }

    /* ---------------- the connection ---------------- */
    private void attach(Socket s) throws IOException {
        s.setTcpNoDelay(true);
        s.setKeepAlive(true);
        Writer w = new BufferedWriter(new OutputStreamWriter(s.getOutputStream(), StandardCharsets.UTF_8), 65536);
        synchronized (this) { sock = s; out = w; }
        io.execute(() -> read(s));
    }

    private void read(Socket s) {
        String why = "";
        try (BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8), 65536)) {
            String line;
            while ((line = in.readLine()) != null) if (!line.isEmpty()) emit("message", "data", line, null, null);
        } catch (IOException e) {
            why = String.valueOf(e.getMessage());
        }
        synchronized (this) {
            // closed from here (close()): the page knows already
            if (sock != s) return;
            sock = null;
            out = null;
        }
        closeQuietly(s);
        emit("closed", "reason", why.isEmpty() ? "соединение закрыто" : why, null, null);
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try { s.close(); } catch (IOException ignored) { /* closed */ }
    }

    private void closeSock() {
        Socket s;
        synchronized (this) { s = sock; sock = null; out = null; }
        closeQuietly(s);
    }

    /* ---------------- hosting ---------------- */
    @PluginMethod
    public void host(PluginCall call) {
        final int port = call.getInt("port", 47810);
        beaconPort = call.getInt("beaconPort", 47811);
        beaconText = call.getString("beacon", "");
        io.execute(() -> {
            try {
                closeServer();
                ServerSocket ss = null;
                IOException last = null;
                for (int p = port; p < port + 6 && ss == null; p++) {
                    ServerSocket t = new ServerSocket();
                    try {
                        t.setReuseAddress(true);
                        t.bind(new InetSocketAddress(p));
                        ss = t;
                    } catch (IOException e) {
                        last = e;
                        try { t.close(); } catch (IOException ignored) { /* closed */ }
                    }
                }
                if (ss == null) throw last != null ? last : new IOException("порт занят");
                synchronized (this) { server = ss; }
                final ServerSocket srv = ss;
                io.execute(() -> accept(srv));
                startBeacon();
                JSObject r = new JSObject();
                r.put("port", srv.getLocalPort());
                r.put("addresses", addressArray());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    private void accept(ServerSocket srv) {
        while (!srv.isClosed()) {
            try {
                Socket s = srv.accept();
                boolean busy;
                synchronized (this) { busy = sock != null && !sock.isClosed(); }
                if (busy) {
                    try {
                        OutputStream o = s.getOutputStream();
                        o.write("{\"t\":\"busy\"}\n".getBytes(StandardCharsets.UTF_8));
                        o.flush();
                        s.shutdownOutput();
                    } catch (IOException ignored) { /* gone */ }
                    timer.schedule(() -> closeQuietly(s), 500, TimeUnit.MILLISECONDS);
                    continue;
                }
                attach(s);
                emit("peer", null, null, null, null);
            } catch (IOException e) {
                if (srv.isClosed()) return;
            }
        }
    }

    private synchronized void closeServer() {
        if (server != null) {
            try { server.close(); } catch (IOException ignored) { /* closed */ }
            server = null;
        }
    }

    private synchronized void startBeacon() {
        stopBeacon();
        try {
            DatagramSocket ds = new DatagramSocket();
            ds.setBroadcast(true);
            beaconSock = ds;
            beaconTask = timer.scheduleAtFixedRate(() -> {
                byte[] b = beaconText.getBytes(StandardCharsets.UTF_8);
                for (InetAddress a : broadcasts()) {
                    try { ds.send(new DatagramPacket(b, b.length, a, beaconPort)); } catch (IOException ignored) { /* that network is down */ }
                }
            }, 0, 1, TimeUnit.SECONDS);
        } catch (IOException ignored) {
            /* no broadcast here: the guest types the address */
        }
    }

    private synchronized void stopBeacon() {
        if (beaconTask != null) beaconTask.cancel(false);
        beaconTask = null;
        if (beaconSock != null) beaconSock.close();
        beaconSock = null;
    }

    @PluginMethod
    public void beacon(PluginCall call) {
        beaconText = call.getString("beacon", "");
        call.resolve();
    }

    @PluginMethod
    public void stopHost(PluginCall call) {
        stopBeacon();
        closeServer();
        call.resolve();
    }

    /* ---------------- joining, messages ---------------- */
    @PluginMethod
    public void join(PluginCall call) {
        final String host = call.getString("host", "");
        final int port = call.getInt("port", 47810);
        io.execute(() -> {
            Socket s = new Socket();
            try {
                s.connect(new InetSocketAddress(host, port), 6000);
                closeSock();
                attach(s);
                call.resolve();
            } catch (Exception e) {
                closeQuietly(s);
                call.reject(e instanceof SocketTimeoutException ? "timed out" : String.valueOf(e.getMessage()));
            }
        });
    }

    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void send(PluginCall call) {
        final String data = call.getString("data", "");
        writer.execute(() -> {
            Writer w;
            synchronized (this) { w = out; }
            if (w == null) return;
            try {
                w.write(data);
                w.write('\n');
                w.flush();
            } catch (IOException ignored) {
                /* the reader notices the closed connection */
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        writer.execute(this::closeSock);
        call.resolve();
    }

    /* ---------------- finding games ---------------- */
    @PluginMethod
    public void scan(PluginCall call) {
        final int port = call.getInt("port", 47811);
        synchronized (this) {
            if (scanSock != null) { call.resolve(); return; }
            try {
                WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi != null) {
                    lock = wifi.createMulticastLock("khl-lan");
                    lock.setReferenceCounted(false);
                    lock.acquire();
                }
            } catch (Exception ignored) { /* no Wi-Fi: a hotspot or a cable still works */ }
            try {
                DatagramSocket ds = new DatagramSocket(null);
                ds.setReuseAddress(true);
                ds.setBroadcast(true);
                ds.bind(new InetSocketAddress(port));
                scanSock = ds;
                io.execute(() -> listen(ds));
                call.resolve();
            } catch (IOException e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }
    }

    private void listen(DatagramSocket ds) {
        byte[] buf = new byte[8192];
        while (!ds.isClosed()) {
            try {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                ds.receive(p);
                emit("found", "host", p.getAddress().getHostAddress(), "data", new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
            } catch (IOException e) {
                if (ds.isClosed()) return;
            }
        }
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        stopScanning();
        call.resolve();
    }

    private synchronized void stopScanning() {
        if (scanSock != null) scanSock.close();
        scanSock = null;
        if (lock != null && lock.isHeld()) lock.release();
        lock = null;
    }

    @PluginMethod
    public void addresses(PluginCall call) {
        JSObject r = new JSObject();
        r.put("addresses", addressArray());
        call.resolve(r);
    }

    /* ---------------- the networks ---------------- */
    private static List<NetworkInterface> interfaces() {
        try {
            List<NetworkInterface> list = Collections.list(NetworkInterface.getNetworkInterfaces());
            List<NetworkInterface> up = new ArrayList<>();
            for (NetworkInterface n : list) if (n.isUp() && !n.isLoopback()) up.add(n);
            return up;
        } catch (Exception e) {
            return new ArrayList<>();
        }
    }

    private static JSArray addressArray() {
        JSArray a = new JSArray();
        for (NetworkInterface n : interfaces()) {
            for (InterfaceAddress ia : n.getInterfaceAddresses()) {
                InetAddress ad = ia.getAddress();
                if (ad instanceof Inet4Address && !ad.isLoopbackAddress()) a.put(ad.getHostAddress());
            }
        }
        return a;
    }

    private static Set<InetAddress> broadcasts() {
        Set<InetAddress> out = new LinkedHashSet<>();
        for (NetworkInterface n : interfaces()) {
            for (InterfaceAddress ia : n.getInterfaceAddresses()) {
                InetAddress b = ia.getBroadcast();
                if (b != null && ia.getAddress() instanceof Inet4Address) out.add(b);
            }
        }
        try { out.add(InetAddress.getByName("255.255.255.255")); } catch (Exception ignored) { /* always there */ }
        return out;
    }

    @Override
    protected void handleOnDestroy() {
        stopBeacon();
        stopScanning();
        closeServer();
        closeSock();
        writer.shutdownNow();
        io.shutdownNow();
        timer.shutdownNow();
    }
}
