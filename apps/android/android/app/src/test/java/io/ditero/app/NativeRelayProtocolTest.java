package io.ditero.app;

import static org.junit.Assert.*;
import org.junit.Test;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.spec.*;
import java.math.BigInteger;
import java.util.*;

public class NativeRelayProtocolTest {
    // ES256 vectors produced by the relay's jose implementation using the public scalar-1 test key.
    private static final String KEY="{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY\",\"y\":\"T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU\"}";
    private static final String EXPECTED="{\"relayOrigin\":\"https://relay.example.org\",\"installationId\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"offerId\":\"BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU\",\"targetId\":\"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE\",\"registrationId\":\"ccf04645-9d2d-4b73-bba1-2d4d8da477aa\",\"senderKey\":{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY\",\"y\":\"T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU\"},\"deviceThumbprint\":\"xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M\",\"sendCapabilityHash\":\"zCcmW7LwyL0XXiE9abO4l0LW_ytn_DG2y08GDWFCtQc\",\"offerExpires\":1700000300}";
    private static final String RECEIPTEXPECTED="{\"relayOrigin\":\"https://relay.example.org\",\"installationId\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"offerId\":\"BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU\",\"targetId\":\"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE\",\"registrationId\":\"ccf04645-9d2d-4b73-bba1-2d4d8da477aa\",\"senderKey\":{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY\",\"y\":\"T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU\"},\"deviceThumbprint\":\"xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M\",\"sendCapabilityHash\":\"zCcmW7LwyL0XXiE9abO4l0LW_ytn_DG2y08GDWFCtQc\",\"offerExpires\":1700000300,\"senderThumbprint\":\"xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M\",\"fidHash\":\"BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY\",\"generation\":1,\"credentialVersion\":1}";
    private static final String OFFER="eyJhbGciOiJFUzI1NiIsInR5cCI6ImRpdGVyby1yZWxheS1vZmZlcitqd3QiLCJraWQiOiJ4eDBCY0Etd01vaHc4YXRZREpPZTZwZUdNb2RrbEcyd1JIQmxYSE12bDBNIn0.eyJhdWQiOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDAzMDAsImluc3RhbGxhdGlvbklkIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsIm9mZmVySWQiOiJCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVIiwidGFyZ2V0SWQiOiJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFIiwicmVnaXN0cmF0aW9uSWQiOiJjY2YwNDY0NS05ZDJkLTRiNzMtYmJhMS0yZDRkOGRhNDc3YWEiLCJzZW5kZXJLZXkiOnsia3R5IjoiRUMiLCJjcnYiOiJQLTI1NiIsIngiOiJheGZSOHVFc1FrZjR2T2JsWTZSQThuY0RmWUV0NnpPZzlLRTVSZGlZd3BZIiwieSI6IlQtTkM0djRhZjV1TzUtdEtmQS1lRml2T00xZHJNVjdPeTdaQWFEZV9VZlUifSwiZGV2aWNlVGh1bWJwcmludCI6Inh4MEJjQS13TW9odzhhdFlESk9lNnBlR01vZGtsRzJ3UkhCbFhITXZsME0iLCJzZW5kQ2FwYWJpbGl0eUhhc2giOiJ6Q2NtVzdMd3lMMFhYaUU5YWJPNGwwTFdfeXRuX0RHMnkwOEdEV0ZDdFFjIn0.76X7VXn5EDwrvHbiYxIc4vuzlKq5DgkAJtEZjjYP1G9VPOJyaY3EdcUoeFIu-w9FNqB2r_kQGXR_Irmx9aXmiA";
    private static final String RECEIPT="eyJhbGciOiJFUzI1NiIsInR5cCI6ImRpdGVyby1yZWxheS1yZWNlaXB0K2p3dCIsImtpZCI6ImZpeHR1cmUifQ.eyJpc3MiOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiYXVkIjoiaHR0cHM6Ly9yZWxheS5leGFtcGxlLm9yZyIsImlhdCI6MTcwMDAwMDAwMSwicmVsYXlPcmlnaW4iOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiaW5zdGFsbGF0aW9uSWQiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIiwib2ZmZXJJZCI6IkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVUiLCJ0YXJnZXRJZCI6IkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUUiLCJyZWdpc3RyYXRpb25JZCI6ImNjZjA0NjQ1LTlkMmQtNGI3My1iYmExLTJkNGQ4ZGE0NzdhYSIsInNlbmRlcktleSI6eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2IiwieCI6ImF4ZlI4dUVzUWtmNHZPYmxZNlJBOG5jRGZZRXQ2ek9nOUtFNVJkaVl3cFkiLCJ5IjoiVC1OQzR2NGFmNXVPNS10S2ZBLWVGaXZPTTFkck1WN095N1pBYURlX1VmVSJ9LCJkZXZpY2VUaHVtYnByaW50IjoieHgwQmNBLXdNb2h3OGF0WURKT2U2cGVHTW9ka2xHMndSSEJsWEhNdmwwTSIsInNlbmRDYXBhYmlsaXR5SGFzaCI6InpDY21XN0x3eUwwWFhpRTlhYk80bDBMV195dG5fREcyeTA4R0RXRkN0UWMiLCJvZmZlckV4cGlyZXMiOjE3MDAwMDAzMDAsInNlbmRlclRodW1icHJpbnQiOiJ4eDBCY0Etd01vaHc4YXRZREpPZTZwZUdNb2RrbEcyd1JIQmxYSE12bDBNIiwiZmlkSGFzaCI6IkJnWUdCZ1lHQmdZR0JnWUdCZ1lHQmdZR0JnWUdCZ1lHQmdZR0JnWUdCZ1kiLCJnZW5lcmF0aW9uIjoxLCJjcmVkZW50aWFsVmVyc2lvbiI6MX0.UQ0as8Zz_SKCjRZ4pbjGjfapU_fA8Mj4lG6nRm9sAkQCqg79QBbSPL30J2GaY-5wF04GHrDY7JZ5D5L9aJsQIw";
    private static final String BADOFFERAUDIENCE="eyJhbGciOiJFUzI1NiIsInR5cCI6ImRpdGVyby1yZWxheS1vZmZlcitqd3QiLCJraWQiOiJ4eDBCY0Etd01vaHc4YXRZREpPZTZwZUdNb2RrbEcyd1JIQmxYSE12bDBNIn0.eyJhdWQiOiJodHRwczovL290aGVyLmV4YW1wbGUub3JnIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDAzMDAsImluc3RhbGxhdGlvbklkIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsIm9mZmVySWQiOiJCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVIiwidGFyZ2V0SWQiOiJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFIiwicmVnaXN0cmF0aW9uSWQiOiJjY2YwNDY0NS05ZDJkLTRiNzMtYmJhMS0yZDRkOGRhNDc3YWEiLCJzZW5kZXJLZXkiOnsia3R5IjoiRUMiLCJjcnYiOiJQLTI1NiIsIngiOiJheGZSOHVFc1FrZjR2T2JsWTZSQThuY0RmWUV0NnpPZzlLRTVSZGlZd3BZIiwieSI6IlQtTkM0djRhZjV1TzUtdEtmQS1lRml2T00xZHJNVjdPeTdaQWFEZV9VZlUifSwiZGV2aWNlVGh1bWJwcmludCI6Inh4MEJjQS13TW9odzhhdFlESk9lNnBlR01vZGtsRzJ3UkhCbFhITXZsME0iLCJzZW5kQ2FwYWJpbGl0eUhhc2giOiJ6Q2NtVzdMd3lMMFhYaUU5YWJPNGwwTFdfeXRuX0RHMnkwOEdEV0ZDdFFjIn0.FJ-sVdfYxxtk6JCn2-kN2xo4uhkCBbnjGf5gXGUqbQnjTTLwQjAeHxu2rn1BWaw4SWkSe3gwamyB65v35xEs_A";
    private static final String BADOFFEREXTRA="eyJhbGciOiJFUzI1NiIsInR5cCI6ImRpdGVyby1yZWxheS1vZmZlcitqd3QiLCJraWQiOiJ4eDBCY0Etd01vaHc4YXRZREpPZTZwZUdNb2RrbEcyd1JIQmxYSE12bDBNIn0.eyJhdWQiOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDAzMDAsImluc3RhbGxhdGlvbklkIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsIm9mZmVySWQiOiJCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVIiwidGFyZ2V0SWQiOiJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFIiwicmVnaXN0cmF0aW9uSWQiOiJjY2YwNDY0NS05ZDJkLTRiNzMtYmJhMS0yZDRkOGRhNDc3YWEiLCJzZW5kZXJLZXkiOnsia3R5IjoiRUMiLCJjcnYiOiJQLTI1NiIsIngiOiJheGZSOHVFc1FrZjR2T2JsWTZSQThuY0RmWUV0NnpPZzlLRTVSZGlZd3BZIiwieSI6IlQtTkM0djRhZjV1TzUtdEtmQS1lRml2T00xZHJNVjdPeTdaQWFEZV9VZlUifSwiZGV2aWNlVGh1bWJwcmludCI6Inh4MEJjQS13TW9odzhhdFlESk9lNnBlR01vZGtsRzJ3UkhCbFhITXZsME0iLCJzZW5kQ2FwYWJpbGl0eUhhc2giOiJ6Q2NtVzdMd3lMMFhYaUU5YWJPNGwwTFdfeXRuX0RHMnkwOEdEV0ZDdFFjIiwiZXh0cmEiOnRydWV9.RDSkOC0xdhwCYuP2kxrIal6o9XAyAE2oLb7nu-rPFaMoufPKb29lXsJyF_9oWXVQCD7NKC2X_JTE7Paxu3wQcg";
    private static final String BADOFFERHEADER="eyJhbGciOiJFUzI1NiIsInR5cCI6ImRpdGVyby1yZWxheS1vZmZlcitqd3QiLCJraWQiOiJ4eDBCY0Etd01vaHc4YXRZREpPZTZwZUdNb2RrbEcyd1JIQmxYSE12bDBNIiwiandrIjp7Imt0eSI6IkVDIiwiY3J2IjoiUC0yNTYiLCJ4IjoiYXhmUjh1RXNRa2Y0dk9ibFk2UkE4bmNEZllFdDZ6T2c5S0U1UmRpWXdwWSIsInkiOiJULU5DNHY0YWY1dU81LXRLZkEtZUZpdk9NMWRyTVY3T3k3WkFhRGVfVWZVIn19.eyJhdWQiOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDAzMDAsImluc3RhbGxhdGlvbklkIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsIm9mZmVySWQiOiJCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVIiwidGFyZ2V0SWQiOiJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFIiwicmVnaXN0cmF0aW9uSWQiOiJjY2YwNDY0NS05ZDJkLTRiNzMtYmJhMS0yZDRkOGRhNDc3YWEiLCJzZW5kZXJLZXkiOnsia3R5IjoiRUMiLCJjcnYiOiJQLTI1NiIsIngiOiJheGZSOHVFc1FrZjR2T2JsWTZSQThuY0RmWUV0NnpPZzlLRTVSZGlZd3BZIiwieSI6IlQtTkM0djRhZjV1TzUtdEtmQS1lRml2T00xZHJNVjdPeTdaQWFEZV9VZlUifSwiZGV2aWNlVGh1bWJwcmludCI6Inh4MEJjQS13TW9odzhhdFlESk9lNnBlR01vZGtsRzJ3UkhCbFhITXZsME0iLCJzZW5kQ2FwYWJpbGl0eUhhc2giOiJ6Q2NtVzdMd3lMMFhYaUU5YWJPNGwwTFdfeXRuX0RHMnkwOEdEV0ZDdFFjIn0.8s-D6osnsW07YKth_MCawUwiUYZ_0rADTfb5O4UqhvVYFDbuGP7RT3rxnlOnhEzKAoOtsJZ3bPDOzihk34fAkA";
    private static final String BADRECEIPTAUDIENCE="eyJhbGciOiJFUzI1NiIsInR5cCI6ImRpdGVyby1yZWxheS1yZWNlaXB0K2p3dCIsImtpZCI6ImZpeHR1cmUifQ.eyJpc3MiOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiYXVkIjoiaHR0cHM6Ly9vdGhlci5leGFtcGxlLm9yZyIsImlhdCI6MTcwMDAwMDAwMSwicmVsYXlPcmlnaW4iOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiaW5zdGFsbGF0aW9uSWQiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIiwib2ZmZXJJZCI6IkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVUiLCJ0YXJnZXRJZCI6IkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUUiLCJyZWdpc3RyYXRpb25JZCI6ImNjZjA0NjQ1LTlkMmQtNGI3My1iYmExLTJkNGQ4ZGE0NzdhYSIsInNlbmRlcktleSI6eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2IiwieCI6ImF4ZlI4dUVzUWtmNHZPYmxZNlJBOG5jRGZZRXQ2ek9nOUtFNVJkaVl3cFkiLCJ5IjoiVC1OQzR2NGFmNXVPNS10S2ZBLWVGaXZPTTFkck1WN095N1pBYURlX1VmVSJ9LCJkZXZpY2VUaHVtYnByaW50IjoieHgwQmNBLXdNb2h3OGF0WURKT2U2cGVHTW9ka2xHMndSSEJsWEhNdmwwTSIsInNlbmRDYXBhYmlsaXR5SGFzaCI6InpDY21XN0x3eUwwWFhpRTlhYk80bDBMV195dG5fREcyeTA4R0RXRkN0UWMiLCJvZmZlckV4cGlyZXMiOjE3MDAwMDAzMDAsInNlbmRlclRodW1icHJpbnQiOiJ4eDBCY0Etd01vaHc4YXRZREpPZTZwZUdNb2RrbEcyd1JIQmxYSE12bDBNIiwiZmlkSGFzaCI6IkJnWUdCZ1lHQmdZR0JnWUdCZ1lHQmdZR0JnWUdCZ1lHQmdZR0JnWUdCZ1kiLCJnZW5lcmF0aW9uIjoxLCJjcmVkZW50aWFsVmVyc2lvbiI6MX0.unDAnr16pnpLKqCPZBrtUW6JCNCwMtQ__uhI65pYkl52vo_CeiDtp3vH-vshsJfgwhIkxS2SGfNwbZL6oySrXw";
    private static final String BADRECEIPTFUTURE="eyJhbGciOiJFUzI1NiIsInR5cCI6ImRpdGVyby1yZWxheS1yZWNlaXB0K2p3dCIsImtpZCI6ImZpeHR1cmUifQ.eyJpc3MiOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiYXVkIjoiaHR0cHM6Ly9yZWxheS5leGFtcGxlLm9yZyIsImlhdCI6MTcwMDAwMDQwMCwicmVsYXlPcmlnaW4iOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiaW5zdGFsbGF0aW9uSWQiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIiwib2ZmZXJJZCI6IkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVUiLCJ0YXJnZXRJZCI6IkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUUiLCJyZWdpc3RyYXRpb25JZCI6ImNjZjA0NjQ1LTlkMmQtNGI3My1iYmExLTJkNGQ4ZGE0NzdhYSIsInNlbmRlcktleSI6eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2IiwieCI6ImF4ZlI4dUVzUWtmNHZPYmxZNlJBOG5jRGZZRXQ2ek9nOUtFNVJkaVl3cFkiLCJ5IjoiVC1OQzR2NGFmNXVPNS10S2ZBLWVGaXZPTTFkck1WN095N1pBYURlX1VmVSJ9LCJkZXZpY2VUaHVtYnByaW50IjoieHgwQmNBLXdNb2h3OGF0WURKT2U2cGVHTW9ka2xHMndSSEJsWEhNdmwwTSIsInNlbmRDYXBhYmlsaXR5SGFzaCI6InpDY21XN0x3eUwwWFhpRTlhYk80bDBMV195dG5fREcyeTA4R0RXRkN0UWMiLCJvZmZlckV4cGlyZXMiOjE3MDAwMDAzMDAsInNlbmRlclRodW1icHJpbnQiOiJ4eDBCY0Etd01vaHc4YXRZREpPZTZwZUdNb2RrbEcyd1JIQmxYSE12bDBNIiwiZmlkSGFzaCI6IkJnWUdCZ1lHQmdZR0JnWUdCZ1lHQmdZR0JnWUdCZ1lHQmdZR0JnWUdCZ1kiLCJnZW5lcmF0aW9uIjoxLCJjcmVkZW50aWFsVmVyc2lvbiI6MX0.HGYdhWpR-JEE_JthSVEEUgAlc6h9PtYg-Ti1hiG4JIMA1JVwlCbD0EiDU__m6AOxbJxCZsIo7OthClOM1ownJg";
    private static final String BADRECEIPTEXTRA="eyJhbGciOiJFUzI1NiIsInR5cCI6ImRpdGVyby1yZWxheS1yZWNlaXB0K2p3dCIsImtpZCI6ImZpeHR1cmUifQ.eyJpc3MiOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiYXVkIjoiaHR0cHM6Ly9yZWxheS5leGFtcGxlLm9yZyIsImlhdCI6MTcwMDAwMDAwMSwicmVsYXlPcmlnaW4iOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiaW5zdGFsbGF0aW9uSWQiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIiwib2ZmZXJJZCI6IkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVUiLCJ0YXJnZXRJZCI6IkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUUiLCJyZWdpc3RyYXRpb25JZCI6ImNjZjA0NjQ1LTlkMmQtNGI3My1iYmExLTJkNGQ4ZGE0NzdhYSIsInNlbmRlcktleSI6eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2IiwieCI6ImF4ZlI4dUVzUWtmNHZPYmxZNlJBOG5jRGZZRXQ2ek9nOUtFNVJkaVl3cFkiLCJ5IjoiVC1OQzR2NGFmNXVPNS10S2ZBLWVGaXZPTTFkck1WN095N1pBYURlX1VmVSJ9LCJkZXZpY2VUaHVtYnByaW50IjoieHgwQmNBLXdNb2h3OGF0WURKT2U2cGVHTW9ka2xHMndSSEJsWEhNdmwwTSIsInNlbmRDYXBhYmlsaXR5SGFzaCI6InpDY21XN0x3eUwwWFhpRTlhYk80bDBMV195dG5fREcyeTA4R0RXRkN0UWMiLCJvZmZlckV4cGlyZXMiOjE3MDAwMDAzMDAsInNlbmRlclRodW1icHJpbnQiOiJ4eDBCY0Etd01vaHc4YXRZREpPZTZwZUdNb2RrbEcyd1JIQmxYSE12bDBNIiwiZmlkSGFzaCI6IkJnWUdCZ1lHQmdZR0JnWUdCZ1lHQmdZR0JnWUdCZ1lHQmdZR0JnWUdCZ1kiLCJnZW5lcmF0aW9uIjoxLCJjcmVkZW50aWFsVmVyc2lvbiI6MSwiZXhwIjoxNzAwMDAwNDAwfQ.qRtJsszIv5VK1josfobqYsybCuj-zHhjm7akzu6DmQlfcZN9QjnrMvR3_56SXlVmOjEF7vJ-V25Ew1a0U6K1RA";
    private static final String BADRECEIPTGENERATION="eyJhbGciOiJFUzI1NiIsInR5cCI6ImRpdGVyby1yZWxheS1yZWNlaXB0K2p3dCIsImtpZCI6ImZpeHR1cmUifQ.eyJpc3MiOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiYXVkIjoiaHR0cHM6Ly9yZWxheS5leGFtcGxlLm9yZyIsImlhdCI6MTcwMDAwMDAwMSwicmVsYXlPcmlnaW4iOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiaW5zdGFsbGF0aW9uSWQiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIiwib2ZmZXJJZCI6IkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVUiLCJ0YXJnZXRJZCI6IkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUUiLCJyZWdpc3RyYXRpb25JZCI6ImNjZjA0NjQ1LTlkMmQtNGI3My1iYmExLTJkNGQ4ZGE0NzdhYSIsInNlbmRlcktleSI6eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2IiwieCI6ImF4ZlI4dUVzUWtmNHZPYmxZNlJBOG5jRGZZRXQ2ek9nOUtFNVJkaVl3cFkiLCJ5IjoiVC1OQzR2NGFmNXVPNS10S2ZBLWVGaXZPTTFkck1WN095N1pBYURlX1VmVSJ9LCJkZXZpY2VUaHVtYnByaW50IjoieHgwQmNBLXdNb2h3OGF0WURKT2U2cGVHTW9ka2xHMndSSEJsWEhNdmwwTSIsInNlbmRDYXBhYmlsaXR5SGFzaCI6InpDY21XN0x3eUwwWFhpRTlhYk80bDBMV195dG5fREcyeTA4R0RXRkN0UWMiLCJvZmZlckV4cGlyZXMiOjE3MDAwMDAzMDAsInNlbmRlclRodW1icHJpbnQiOiJ4eDBCY0Etd01vaHc4YXRZREpPZTZwZUdNb2RrbEcyd1JIQmxYSE12bDBNIiwiZmlkSGFzaCI6IkJnWUdCZ1lHQmdZR0JnWUdCZ1lHQmdZR0JnWUdCZ1lHQmdZR0JnWUdCZ1kiLCJnZW5lcmF0aW9uIjoyLCJjcmVkZW50aWFsVmVyc2lvbiI6MX0.E-nfOYpZOYQYu76Kipe9nHNNarQyvMUOCEgZAf-pFmfMAnsSqSlu_o13zvh0N9rkGXsAdqEvuUk_k0EhVHhMNQ";
    private static final String STATUSEXPECTED="{\"relayOrigin\":\"https://relay.example.org\",\"installationId\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"offerId\":\"BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU\",\"targetId\":\"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE\",\"registrationId\":\"ccf04645-9d2d-4b73-bba1-2d4d8da477aa\",\"senderKey\":{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY\",\"y\":\"T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU\"},\"deviceThumbprint\":\"xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M\",\"sendCapabilityHash\":\"zCcmW7LwyL0XXiE9abO4l0LW_ytn_DG2y08GDWFCtQc\",\"offerExpires\":1700000300,\"senderThumbprint\":\"xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M\",\"fidHash\":\"BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY\",\"generation\":1,\"credentialVersion\":1,\"kind\":\"target-status\",\"state\":\"confirmed\",\"operationId\":\"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI\",\"digest\":\"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc\"}";
    private static final String STATUS="eyJhbGciOiJFUzI1NiIsInR5cCI6ImRpdGVyby1yZWxheS1yZWNlaXB0K2p3dCIsImtpZCI6ImZpeHR1cmUifQ.eyJpc3MiOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiYXVkIjoiaHR0cHM6Ly9yZWxheS5leGFtcGxlLm9yZyIsImlhdCI6MTcwMDAwMDAwMSwicmVsYXlPcmlnaW4iOiJodHRwczovL3JlbGF5LmV4YW1wbGUub3JnIiwiaW5zdGFsbGF0aW9uSWQiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIiwib2ZmZXJJZCI6IkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVVGQlFVRkJRVUZCUVUiLCJ0YXJnZXRJZCI6IkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUUiLCJyZWdpc3RyYXRpb25JZCI6ImNjZjA0NjQ1LTlkMmQtNGI3My1iYmExLTJkNGQ4ZGE0NzdhYSIsInNlbmRlcktleSI6eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2IiwieCI6ImF4ZlI4dUVzUWtmNHZPYmxZNlJBOG5jRGZZRXQ2ek9nOUtFNVJkaVl3cFkiLCJ5IjoiVC1OQzR2NGFmNXVPNS10S2ZBLWVGaXZPTTFkck1WN095N1pBYURlX1VmVSJ9LCJkZXZpY2VUaHVtYnByaW50IjoieHgwQmNBLXdNb2h3OGF0WURKT2U2cGVHTW9ka2xHMndSSEJsWEhNdmwwTSIsInNlbmRDYXBhYmlsaXR5SGFzaCI6InpDY21XN0x3eUwwWFhpRTlhYk80bDBMV195dG5fREcyeTA4R0RXRkN0UWMiLCJvZmZlckV4cGlyZXMiOjE3MDAwMDAzMDAsInNlbmRlclRodW1icHJpbnQiOiJ4eDBCY0Etd01vaHc4YXRZREpPZTZwZUdNb2RrbEcyd1JIQmxYSE12bDBNIiwiZmlkSGFzaCI6IkJnWUdCZ1lHQmdZR0JnWUdCZ1lHQmdZR0JnWUdCZ1lHQmdZR0JnWUdCZ1kiLCJnZW5lcmF0aW9uIjoxLCJjcmVkZW50aWFsVmVyc2lvbiI6MSwia2luZCI6InRhcmdldC1zdGF0dXMiLCJzdGF0ZSI6ImNvbmZpcm1lZCIsIm9wZXJhdGlvbklkIjoiQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSSIsImRpZ2VzdCI6IkJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2MifQ.m7sCPLeURHOVtQh5P95Z9-TBqJC5O6gkxDV1udk0bNaeFC5r8SPPAosmhNJWh4CCMzMXrJrE5nK_qVJrCvPtnw";

    private static Map<String,Object> key() {return NativeRelayProtocol.parseObject(KEY);}
    private static Map<String,Object> offerExpected() {return NativeRelayProtocol.parseObject(EXPECTED);}
    private static Map<String,Object> receiptExpected() {return NativeRelayProtocol.parseObject(RECEIPTEXPECTED);}
    private static Map<String,Object> pins() {return Map.of("fixture",key());}
    private static void rejected(Runnable action) {
        try {action.run(); fail("Untrusted protocol accepted");} catch(IllegalArgumentException expected) {}
    }
    private static String id(int n) {byte[] bytes=new byte[32]; Arrays.fill(bytes,(byte)n); return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);}
    private static Map<String,Object> confirm() {
        return new LinkedHashMap<>(Map.of("installationId",id(0),"targetId",id(1),"registrationId","ccf04645-9d2d-4b73-bba1-2d4d8da477aa",
                "operationId",id(2),"managementSecret",id(3),"generation",1,"challenge",id(4)));
    }
    @Test public void relayCanonicalDigestAndCredentialVectors() {
        Map<String,Object> body=confirm();
        assertEquals("DEVtBvIDjWqHU1Jf2BiH7FujVzShQTSEfWV65QJch7c",NativeRelayProtocol.semanticDigest(body));
        assertEquals("wnx_yWQfeVBczqlpToFKVTYTfGDEwDrDQHZ4_6M0e4s",NativeRelayProtocol.credentialHash("management",id(3)));
        assertEquals("zCcmW7LwyL0XXiE9abO4l0LW_ytn_DG2y08GDWFCtQc",NativeRelayProtocol.credentialHash("send",id(3)));
        String digest=NativeRelayProtocol.semanticDigest(body);
        body.put("deviceProof","refreshed"); body.put("senderProof","refreshed"); body.put("appCheck","refreshed");
        assertEquals(digest,NativeRelayProtocol.semanticDigest(body)); body.put("generation",2);
        assertNotEquals(digest,NativeRelayProtocol.semanticDigest(body));
        assertEquals("{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"a\",\"y\":\"b\"}",NativeRelayProtocol.canonical(Map.of("y","b","x","a","kty","EC","crv","P-256")));
        assertEquals("{\"value\":\"a\\n\\t\\\"\\\\é\"}",NativeRelayProtocol.canonical(Map.of("value","a\n\t\"\\é")));
    }
    @Test public void strictJsonRejectsDuplicateTruncatedAndAmbiguousInputs() {
        for(String json:List.of("{\"a\":1,\"a\":2}","{\"a\":1,\"\\u0061\":2}","{\"a\":1,}","{a:1}","{\"a\":01}","{}{}",
                "{\"a\":NaN}","{\"a\":1e400}","{\"a\":9007199254740992}","{\"a\":\"\\ud800\"}","{\"a\":\"raw\nline\"}"))
            rejected(()->NativeRelayProtocol.parseObject(json));
        assertEquals("é",NativeRelayProtocol.parseObject("{\"a\":\"é\"}").get("a"));
        String deep="{\"a\":".repeat(26)+"0"+"}".repeat(26); rejected(()->NativeRelayProtocol.parseObject(deep));
        rejected(()->NativeRelayProtocol.parseObject(" ".repeat(16385)+"{}"));
        rejected(()->NativeRelayProtocol.canonical(Map.of("é",1)));
        rejected(()->NativeRelayProtocol.canonical(Map.of("a",1.5)));
    }
    @Test public void canonicalOpaqueIdsAreUnpredictableAndRejectTrailingBits() {
        Set<String> unique=new HashSet<>();
        for(int i=0;i<128;i++) {String value=NativeRelayProtocol.opaqueId(); assertTrue(NativeRelayProtocol.isOpaque(value)); assertTrue(unique.add(value));}
        assertFalse(NativeRelayProtocol.isOpaque(id(0).substring(0,42)+"B"));
        assertFalse(NativeRelayProtocol.isOpaque("ccf04645-9d2d-4b73-bba1-2d4d8da477aa"));
        assertFalse(NativeRelayProtocol.isOpaque(id(0)+"="));
    }
    @Test public void relayOfferVectorRequiresPinnedKeyExactBindingsAndLiveOffer() {
        Map<String,Object> verified=NativeRelayProtocol.verifyOffer(OFFER,key(),offerExpected(),1700000001);
        assertEquals("ccf04645-9d2d-4b73-bba1-2d4d8da477aa",verified.get("registrationId"));
        assertEquals("xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M",NativeRelayProtocol.thumbprint(key()));
        for(String name:List.of("installationId","offerId","targetId","registrationId","deviceThumbprint","sendCapabilityHash")) {
            Map<String,Object> copied=offerExpected(); copied.put(name,name.equals("registrationId")?"other-registration":id(8));
            rejected(()->NativeRelayProtocol.verifyOffer(OFFER,key(),copied,1700000001));
        }
        for(String token:List.of(BADOFFERAUDIENCE,BADOFFEREXTRA,BADOFFERHEADER))
            rejected(()->NativeRelayProtocol.verifyOffer(token,key(),offerExpected(),1700000001));
        rejected(()->NativeRelayProtocol.verifyOffer(OFFER,key(),offerExpected(),1699999999));
        rejected(()->NativeRelayProtocol.verifyOffer(OFFER,key(),offerExpected(),1700000300));
        String[] parts=OFFER.split("\\."); byte[] signature=Base64.getUrlDecoder().decode(parts[2]); signature[0]^=1;
        String tampered=parts[0]+"."+parts[1]+"."+Base64.getUrlEncoder().withoutPadding().encodeToString(signature);
        rejected(()->NativeRelayProtocol.verifyOffer(tampered,key(),offerExpected(),1700000001));
        try {verified.put("targetId",id(9)); fail();} catch(UnsupportedOperationException expected) {}
    }
    @Test public void relayReceiptRejectsCopiedGenerationCredentialFidAndUnpinnedSigner() {
        assertEquals(1.0,NativeRelayProtocol.verifyReceipt(RECEIPT,pins(),receiptExpected(),1700001000).get("generation"));
        for(String name:List.of("installationId","offerId","targetId","registrationId","senderThumbprint","deviceThumbprint","sendCapabilityHash","fidHash","relayOrigin","offerExpires","generation","credentialVersion")) {
            Map<String,Object> copied=receiptExpected(); Object current=copied.get(name);
            copied.put(name,current instanceof Number?((Number)current).longValue()+1:name.equals("relayOrigin")?"https://other.example.org":name.equals("registrationId")?"other-registration":id(8));
            rejected(()->NativeRelayProtocol.verifyReceipt(RECEIPT,pins(),copied,1700001000));
        }
        for(String token:List.of(BADRECEIPTAUDIENCE,BADRECEIPTFUTURE,BADRECEIPTEXTRA,BADRECEIPTGENERATION))
            rejected(()->NativeRelayProtocol.verifyReceipt(token,pins(),receiptExpected(),1700000002));
        rejected(()->NativeRelayProtocol.verifyReceipt(RECEIPT,Map.of("other",key()),receiptExpected(),1700001000));
        rejected(()->NativeRelayProtocol.verifyReceipt(RECEIPT,pins(),receiptExpected(),1700000000));
        Map<String,Object> incomplete=receiptExpected(); incomplete.remove("generation");
        rejected(()->NativeRelayProtocol.verifyReceipt(RECEIPT,pins(),incomplete,1700001000));
    }
    @Test public void targetStatusReceiptBindsOperationDigestAndState() {
        Map<String,Object> expected=NativeRelayProtocol.parseObject(STATUSEXPECTED);
        assertEquals("confirmed",NativeRelayProtocol.verifyReceipt(STATUS,pins(),expected,1700000002).get("state"));
        for(String field:List.of("operationId","digest","state")) {
            Map<String,Object> copied=new LinkedHashMap<>(expected); copied.put(field,field.equals("state")?"retired":id(8));
            rejected(()->NativeRelayProtocol.verifyReceipt(STATUS,pins(),copied,1700000002));
        }
        rejected(()->NativeRelayProtocol.verifyReceipt(STATUS,pins(),receiptExpected(),1700000002));
        rejected(()->NativeRelayProtocol.verifyReceipt(RECEIPT,pins(),expected,1700000002));
    }
    private static KeyPair pair() throws Exception {
        KeyPairGenerator generator=KeyPairGenerator.getInstance("EC"); generator.initialize(new ECGenParameterSpec("secp256r1")); return generator.generateKeyPair();
    }
    @Test public void javaProofSignsJoseRawEs256AndBindsAllRequestInputs() throws Exception {
        KeyPair device=pair(); Map<String,Object> jwk=NativeRelayProtocol.publicJwk(device.getPublic());
        Map<String,Object> request=confirm(); String token=NativeRelayProtocol.deviceProof(device.getPrivate(),jwk,"https://relay.example.org","/v1/confirm",request,1700000000);
        String[] parts=token.split("\\."); Map<String,Object> header=NativeRelayProtocol.parseObject(new String(Base64.getUrlDecoder().decode(parts[0]),StandardCharsets.UTF_8));
        Map<String,Object> claims=NativeRelayProtocol.parseObject(new String(Base64.getUrlDecoder().decode(parts[1]),StandardCharsets.UTF_8));
        assertEquals(Map.of("alg","ES256","typ","ditero-relay-proof+jwt","kid",NativeRelayProtocol.thumbprint(jwk)),header);
        assertEquals("https://relay.example.org",claims.get("aud")); assertEquals("POST",claims.get("method"));
        assertEquals("/v1/confirm",claims.get("path")); assertEquals(request.get("operationId"),claims.get("operationId"));
        assertEquals("DEVtBvIDjWqHU1Jf2BiH7FujVzShQTSEfWV65QJch7c",claims.get("digest"));
        assertEquals(1700000000.0,claims.get("iat")); assertEquals(1700000060.0,claims.get("exp")); assertTrue(NativeRelayProtocol.isOpaque((String)claims.get("nonce")));
        byte[] raw=Base64.getUrlDecoder().decode(parts[2]); assertEquals(64,raw.length);
        Signature verifier=Signature.getInstance("SHA256withECDSA"); verifier.initVerify(device.getPublic()); verifier.update((parts[0]+"."+parts[1]).getBytes(StandardCharsets.US_ASCII));
        assertTrue(verifier.verify(NativeRelayProtocol.rawToDer(raw)));
        request.put("generation",2); String next=NativeRelayProtocol.deviceProof(device.getPrivate(),jwk,"https://relay.example.org","/v1/confirm",request,1700000000);
        assertNotEquals(token,next);
        KeyPair other=pair(); rejected(()-> {try {NativeRelayProtocol.deviceProof(other.getPrivate(),jwk,"https://relay.example.org","/v1/confirm",confirm(),1700000000);} catch(GeneralSecurityException e) {throw new AssertionError(e);}});
    }
    @Test public void malformedDerAndNonP256KeysFailClosed() throws Exception {
        for(byte[] der:List.of(new byte[]{0x30,6,2,1,(byte)0x80,2,1,1},new byte[]{0x30,7,2,2,0,1,2,1,1},new byte[]{0x30,6,2,1,1,2,1,1,0}))
            rejected(()->NativeRelayProtocol.derToRaw(der));
        Map<String,Object> invalid=key(); invalid.put("x",id(0)); invalid.put("y",id(0)); rejected(()->NativeRelayProtocol.thumbprint(invalid));
        Map<String,Object> privateJwk=key(); privateJwk.put("d",id(1)); rejected(()->NativeRelayProtocol.thumbprint(privateJwk));
        KeyPairGenerator generator=KeyPairGenerator.getInstance("EC"); generator.initialize(new ECGenParameterSpec("secp384r1"));
        PublicKey key=generator.generateKeyPair().getPublic(); rejected(()-> {try {NativeRelayProtocol.publicJwk(key);} catch(GeneralSecurityException e) {throw new AssertionError(e);}});
    }
    public static void main(String[] args) throws Exception {
        AlgorithmParameters params=AlgorithmParameters.getInstance("EC"); params.init(new ECGenParameterSpec("secp256r1"));
        PrivateKey privateKey=KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(BigInteger.ONE,params.getParameterSpec(ECParameterSpec.class)));
        System.out.println(NativeRelayProtocol.deviceProof(privateKey,key(),"https://relay.example.org","/v1/confirm",confirm(),System.currentTimeMillis()/1000));
    }
}
