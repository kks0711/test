import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.X509Certificate;
import java.util.Arrays;

/**
 * APK Signature Scheme v2 서명기 (JDK 표준 라이브러리만 사용, 단일 파일).
 * v1(JAR) 서명과 zipalign 이 끝난 APK 위에 v2 서명 블록만 추가한다.
 *
 *   KS_PASS=... java ApkSignV2.java sign   <in.apk> <out.apk> <keystore.p12> <alias>
 *   java ApkSignV2.java verify <apk>     (v2 블록의 다이제스트·서명을 독립적으로 재계산)
 */
public class ApkSignV2 {
    static final int CHUNK = 1024 * 1024;
    static final int ALG_RSA_PKCS1_SHA256 = 0x0103;
    static final int V2_ID = 0x7109871a;

    public static void main(String[] a) throws Exception {
        if (a.length == 5 && a[0].equals("sign")) {
            String pw = System.getenv("KS_PASS");
            if (pw == null) { System.err.println("KS_PASS 환경변수가 필요합니다"); System.exit(2); }
            char[] pass = pw.toCharArray();
            KeyStore ks = KeyStore.getInstance("PKCS12");
            try (FileInputStream in = new FileInputStream(a[3])) { ks.load(in, pass); }
            PrivateKey key = (PrivateKey) ks.getKey(a[4], pass);
            X509Certificate cert = (X509Certificate) ks.getCertificate(a[4]);
            byte[] apk = Files.readAllBytes(Paths.get(a[1]));
            Files.write(Paths.get(a[2]), sign(apk, key, cert));
            System.out.println("v2 signed: " + a[2]);
        } else if (a.length == 2 && a[0].equals("verify")) {
            System.exit(verify(Files.readAllBytes(Paths.get(a[1]))) ? 0 : 3);
        } else {
            System.err.println("usage: ApkSignV2.java sign <in> <out> <p12> <alias>   (KS_PASS 환경변수)\n"
                    + "       ApkSignV2.java verify <apk>");
            System.exit(2);
        }
    }

    static byte[] sign(byte[] apk, PrivateKey key, X509Certificate cert) throws Exception {
        int eocd = findEocd(apk);
        int cdSize = le32(apk, eocd + 12);
        int cdOffset = le32(apk, eocd + 16);

        // 기존 서명 블록이 있으면 제거 (재서명)
        int s1End = cdOffset;
        if (cdOffset >= 24 && new String(apk, cdOffset - 16, 16, "ISO-8859-1").equals("APK Sig Block 42")) {
            long blockSize = le64(apk, cdOffset - 24);
            s1End = (int) (cdOffset - blockSize - 8);
        }
        byte[] s1 = Arrays.copyOfRange(apk, 0, s1End);
        byte[] s3 = Arrays.copyOfRange(apk, cdOffset, cdOffset + cdSize);
        byte[] s4 = Arrays.copyOfRange(apk, eocd, apk.length);
        ByteBuffer.wrap(s4).order(ByteOrder.LITTLE_ENDIAN).putInt(16, s1End);

        byte[] digest = contentDigest(s1, s3, s4);

        byte[] digests = lp(lp(concat(u32(ALG_RSA_PKCS1_SHA256), lp(digest))));
        byte[] certs = lp(lp(cert.getEncoded()));
        byte[] signedData = concat(digests, certs, lp(new byte[0]));

        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initSign(key);
        sig.update(signedData);
        byte[] signature = sig.sign();

        byte[] signatures = lp(lp(concat(u32(ALG_RSA_PKCS1_SHA256), lp(signature))));
        byte[] publicKey = cert.getPublicKey().getEncoded();
        byte[] signer = concat(lp(signedData), signatures, lp(publicKey));
        byte[] value = lp(lp(signer));

        long pairLen = 4 + value.length;
        long blockSizeField = 8 + pairLen + 8 + 16;
        ByteArrayOutputStream blk = new ByteArrayOutputStream();
        blk.write(u64(blockSizeField));
        blk.write(u64(pairLen));
        blk.write(u32(V2_ID));
        blk.write(value);
        blk.write(u64(blockSizeField));
        blk.write("APK Sig Block 42".getBytes("ISO-8859-1"));
        byte[] block = blk.toByteArray();

        byte[] eocdOut = s4.clone();
        ByteBuffer.wrap(eocdOut).order(ByteOrder.LITTLE_ENDIAN).putInt(16, s1End + block.length);
        return concat(s1, block, s3, eocdOut);
    }


    /** v2 서명 블록을 파싱해 콘텐츠 다이제스트와 RSA 서명을 처음부터 다시 검증한다. */
    static boolean verify(byte[] apk) throws Exception {
        int eocd = findEocd(apk);
        int cdSize = le32(apk, eocd + 12);
        int cdOffset = le32(apk, eocd + 16);
        if (cdOffset < 32 || !new String(apk, cdOffset - 16, 16, "ISO-8859-1").equals("APK Sig Block 42")) {
            System.out.println("v2.present=false");
            return false;
        }
        long blockSize = le64(apk, cdOffset - 24);
        int blockStart = (int) (cdOffset - blockSize - 8);
        ByteBuffer pairs = ByteBuffer.wrap(apk, blockStart + 8, (int) (blockSize - 24)).order(ByteOrder.LITTLE_ENDIAN);
        ByteBuffer v2 = null;
        while (pairs.remaining() >= 12) {
            long len = pairs.getLong();
            int id = pairs.getInt();
            byte[] val = new byte[(int) len - 4];
            pairs.get(val);
            if (id == V2_ID) v2 = ByteBuffer.wrap(val).order(ByteOrder.LITTLE_ENDIAN);
        }
        if (v2 == null) { System.out.println("v2.present=false"); return false; }
        System.out.println("v2.present=true");

        v2.getInt();                                   // signers 전체 길이
        ByteBuffer signer = slice(v2);
        ByteBuffer signedData = slice(signer);
        ByteBuffer signatures = slice(signer);
        byte[] pubKey = bytes(slice(signer));

        byte[] signedDataBytes = new byte[signedData.remaining()];
        signedData.duplicate().get(signedDataBytes);

        ByteBuffer digests = slice(signedData);        // digests 시퀀스
        ByteBuffer dig = slice(digests);
        int dAlg = dig.getInt();
        byte[] expected = bytes(slice(dig));

        ByteBuffer certs = slice(signedData);
        byte[] certDer = bytes(slice(certs));

        ByteBuffer sg = slice(signatures);
        int sAlg = sg.getInt();
        byte[] sigBytes = bytes(slice(sg));

        byte[] s1 = Arrays.copyOfRange(apk, 0, blockStart);
        byte[] s3 = Arrays.copyOfRange(apk, cdOffset, cdOffset + cdSize);
        byte[] s4 = Arrays.copyOfRange(apk, eocd, apk.length);
        ByteBuffer.wrap(s4).order(ByteOrder.LITTLE_ENDIAN).putInt(16, blockStart);
        boolean digestOk = Arrays.equals(expected, contentDigest(s1, s3, s4));

        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initVerify(java.security.KeyFactory.getInstance("RSA")
                .generatePublic(new java.security.spec.X509EncodedKeySpec(pubKey)));
        sig.update(signedDataBytes);
        boolean sigOk = sig.verify(sigBytes);

        X509Certificate cert = (X509Certificate) java.security.cert.CertificateFactory.getInstance("X.509")
                .generateCertificate(new java.io.ByteArrayInputStream(certDer));
        boolean keyMatch = Arrays.equals(cert.getPublicKey().getEncoded(), pubKey);

        System.out.println("v2.algorithm=0x" + Integer.toHexString(sAlg) + " digestAlg=0x" + Integer.toHexString(dAlg));
        System.out.println("v2.digestMatches=" + digestOk);
        System.out.println("v2.signatureValid=" + sigOk);
        System.out.println("v2.certMatchesKey=" + keyMatch);
        System.out.println("cert.subject=" + cert.getSubjectX500Principal());
        System.out.println("cert.sha256=" + hex(MessageDigest.getInstance("SHA-256").digest(certDer)));
        boolean ok = digestOk && sigOk && keyMatch;
        System.out.println("v2.verified=" + ok);
        return ok;
    }

    static ByteBuffer slice(ByteBuffer b) {
        int n = b.getInt();
        ByteBuffer s = b.slice().order(ByteOrder.LITTLE_ENDIAN);
        s.limit(n);
        b.position(b.position() + n);
        return s;
    }

    static byte[] bytes(ByteBuffer b) {
        byte[] r = new byte[b.remaining()];
        b.duplicate().get(r);
        return r;
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02X", x));
        return s.toString();
    }

    static byte[] contentDigest(byte[]... sections) throws Exception {
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        ByteArrayOutputStream chunks = new ByteArrayOutputStream();
        int count = 0;
        for (byte[] s : sections) {
            for (int off = 0; off < s.length; off += CHUNK) {
                int len = Math.min(CHUNK, s.length - off);
                sha.reset();
                sha.update((byte) 0xa5);
                sha.update(u32(len));
                sha.update(s, off, len);
                chunks.write(sha.digest());
                count++;
            }
        }
        sha.reset();
        sha.update((byte) 0x5a);
        sha.update(u32(count));
        sha.update(chunks.toByteArray());
        return sha.digest();
    }

    static int findEocd(byte[] b) {
        for (int i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
            if (b[i] == 0x50 && b[i + 1] == 0x4b && b[i + 2] == 5 && b[i + 3] == 6) return i;
        }
        throw new IllegalArgumentException("ZIP EOCD not found");
    }

    static int le32(byte[] b, int o) { return ByteBuffer.wrap(b, o, 4).order(ByteOrder.LITTLE_ENDIAN).getInt(); }
    static long le64(byte[] b, int o) { return ByteBuffer.wrap(b, o, 8).order(ByteOrder.LITTLE_ENDIAN).getLong(); }
    static byte[] u32(long v) { return ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt((int) v).array(); }
    static byte[] u64(long v) { return ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(v).array(); }
    static byte[] lp(byte[] d) { return concat(u32(d.length), d); }
    static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] out = new byte[n];
        int o = 0;
        for (byte[] p : parts) { System.arraycopy(p, 0, out, o, p.length); o += p.length; }
        return out;
    }
}
