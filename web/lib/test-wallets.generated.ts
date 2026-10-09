/**
 * The 100 fixed test wallets that scripts/browser-test-wallet.js and the e2e
 * scripts sign with. Wallet i's Ed25519 seed is sha256("sheaf-test-wallet:" + i),
 * so anyone can re-derive these and every test run is predictable. They are test
 * wallets by construction: never fund them with anything real.
 *
 * Generated; do not edit by hand.
 */
export const TEST_WALLETS: readonly string[] = [
  "HrVxUzyPCqApHEtSVd5e3Sqjx6hiXyGKApfHnV5J8fPf", // 0
  "DGVWXQWFTyxX2cLx3AiWbCwyFevz7PnfBo9k7RQNQ3Lq", // 1
  "7qigPUZ8qbFXABkMYqCdJExVSDHp6f9rviNmCw237K9F", // 2
  "FrYkyiSqkjNoMhKKA9xpjfa1rW6vzJ7z57xQVnwK1tu7", // 3
  "HygUbf8sounD1PPyXN2jVLuh9PeWS2qdn55mt5kskFCv", // 4
  "Bvj3e1hqy4GqnKjd7D3PtWZgkhXfjoSAUHQC57ak8VYs", // 5
  "6Txw6QihwG2vQvj3FTva3wH6bsk6CTiGrRvxc8r5v9X5", // 6
  "Hf4GAv1yiCXuYdw2vMis3pKScqzwEEJjhPzk8YDjEHNS", // 7
  "3H5p8noLg3Xsj6e3Re3744W3yACHuJ4C5muPGBs7E3WW", // 8
  "5uoR2DC1kRWeiLi3cZq12f8RFtnEdGAHrTSYw8zCjnTx", // 9
  "G5wyFtZViULEengf6VNxpaqJV6pFpwwB4CU2E4SyeyKw", // 10
  "56wDa6DFSgcUdK8TwLGKN2u5W8bev3j3GxKqiFH4Sd7L", // 11
  "G3X4HC3dY9TY31zRekv1u9oq4DMnaE3hsW5JjpK1hJpg", // 12
  "25Bi1xVCmyDsanDTjNfn519Xw3warodcydRCATDSzUHv", // 13
  "AqwXDaAMssNECg1mJPzsN3Q9f5Ry1iELsCi2CSh8sqML", // 14
  "Do2LNouhH7pkQq21kvg28ktUQrRrcWzpMfAFKQZT52bE", // 15
  "H1CDXtdkZiKbxjHjLwahgRWXycZy4r59aYS8Jh1ZHEGZ", // 16
  "E568c5XXPvVkRinixVF2MddsaEvd7Vh5QUH2JJdL9sTD", // 17
  "EJTHaMBSzHr46mRsGVsfCJgUfL2yiWEoALvZarwB8Aa1", // 18
  "5PGYePZapJCtPBa1ewK6Duei52oo5ARna71NCmkBoQs", // 19
  "6Nimxf5chsarjYfie2wE2SGrw2Ecxjh3cSzFWvQBdFfK", // 20
  "239BwSQkToLtae19Jh4qxFdH4ydKHfxEpBtEUERQq74W", // 21
  "B4og7syYbbfNzYwpYv5HfiryMExr3N1CqaiTMms5C1Ee", // 22
  "2VMeuTCZuD3SmpoTFpLEtcbty9NnZudsaMoV893SQC8Q", // 23
  "8EC38AwhkFGL1msQ8f8WcaaLXncH9TN6VWo1ZDdxJ3zV", // 24
  "9DyGrYx9wQV3Yp3fd54Uc77SJCvGxXiLm45YgseX9K5b", // 25
  "5ZRuHg3TAMX3fsWk2cZAbcWh7hNbdw6hzGEswB53f9Pi", // 26
  "457KMjJSQS9Pxe2jEMGPSvB43AKgGDK7NJvRRbrFKbPT", // 27
  "D3V24GoQf3R4gq4poAx3tj5SjimtUhEazX6PJhqXnQxm", // 28
  "9YdomzgraAcyGHTKDAPVzysqgdcM6QL4wasNCFvxzbbe", // 29
  "C5UBivmKFprSYDKT87pfQpfduT2xxm6HUbCCJy3qCFeQ", // 30
  "8qBqrSzU9eoaVK7aUeMqYdXnTKVfLMvNqi4m1WMx9B9x", // 31
  "EPP2jD7sAEgksNEvXSm2srJ2nnst7fdqjwpjrkxryNpG", // 32
  "BGWHYUEPPRkuwYWpgr15G2NRsbNxiF6sxKrjjJ8HvxgJ", // 33
  "7UhRCPFQxL8By7apkXex6vargfdqJBKYSJr8hhuvURjP", // 34
  "EfoKJmNqWCWdiCNHEsKTvKQuRQVXrXPuYYn3nzicHQkx", // 35
  "GeJT6f1nZ9sEfJYr6as4xeGZrbo9vws6uKfmyLLd1Tzb", // 36
  "HT8gGZkpT9EbTfpDJRY7VjwFuQqRPheKqnhGDYHCLZqB", // 37
  "CfTeX5mwfZQcmydqV1sQPRL3wH4QAn2MT8YXGAdeFv8d", // 38
  "EpgY1Z7FzNgm8B9nsGeL5SXce5BtLRj5e4jBuuxNm7ww", // 39
  "6CXbutvBrLfsAFDPMei5G55DPL8C11fzHLTk9K95jEpt", // 40
  "Gxa3YFM6Cpd5JvaGUx65J7jt3tP3DBZDgYVn4CF11fCW", // 41
  "D1gLrdoL1QMpEmpMSt2Ux2mYHVAe2BBEt6dbxzD9JXii", // 42
  "6Y9K2LvJZJ3mz7aiAEtk6Y7xmKBPPjPzg4xv9ytoSJHu", // 43
  "CBPzecM7kyLYEg7NoWkbs6L4UntHrreRdCYeQhhuRBLh", // 44
  "AQfH8SnrRmyZaoGs11JGbdt5sP7RdCVfHFqE8rhxrzHR", // 45
  "28Ng3dFUkZwWegy8F76omfb4LGA48JM2diK4oJpgUyYL", // 46
  "9ov6WrJFHQUCNWVvVNvetfL9kJCmoRmfmyyJebX8669N", // 47
  "7qk5mFTSYvF2dtnpMDME4wik39zBHskRYfHYNRURqcha", // 48
  "mFjg787xRSfWUz18FiXMBoSiX7ESuafxsgYJfJazzQr", // 49
  "6r6iKaQQVtsfEHoZ1heE3n14HsWif2unswBeEGLgxAn4", // 50
  "CiEHTSguBtKQvxeJdDXWQG5p1ENPxVNGLjLEa7dofV9C", // 51
  "Cn3yG9Z6N1yamHdThMjo8vdLpVYBFmq6Te4Dn9JFGRpW", // 52
  "3Fwar2YDW6y6TSTFWXWfAJvB4NznumJuERvyY51UTz7K", // 53
  "5K9NcpnXfAHM2j5YvgDMAk7VyoQ4n3fe1W1JnP3WXhDi", // 54
  "BW3H3o5JWMEgm4j4sVqTZH61tf74ovotB9VWqfPNtZUG", // 55
  "5b7KCYvBXs6YFM4uFX57JtxxGV82pSHZHd445qfX28w9", // 56
  "8kkUvNdf3CEmGq1kZoF89mfGCMd7bRWn9aCf3vRWhDP9", // 57
  "7DRHYxGQVhLxvzSBZEkPHqUW2H66GwSxggXuFie4Hrd5", // 58
  "CcWwGZqK3uwwCkgiyPbRmuvwotC3EttS5hRpdYfgbEfU", // 59
  "CqgoqMGLSGfdYPDpKmWa9U9EcD2TMYYzDL189BMFgg6m", // 60
  "6YtTBBjxXrmfRNvnVFC4RwJBMs7EdZwXVTMXBdiB477Y", // 61
  "6iFxzbicouunn6ZWdPNaC9nMD2ZJbfmpju87SmGekARJ", // 62
  "ChtTKnsXibGSEqRMaAfAUviRxKxGNpumSu4GAbDXeJk7", // 63
  "E6vrZRJpYKE1mjz3p5H3492nJBTTVgmyH2EeTgfPbbMQ", // 64
  "CHirocbnytx7uM3MMj4m4Sm1ZsWvtMxsg7HbsdCn9myR", // 65
  "86ZSmjWc2T8rDMKL1dqSh1v86PLQGgrLNayGYzRsL1YL", // 66
  "BGVMFaCtvpF5QwAwc8AZghwG24zvau8waJVmhkuwhh2c", // 67
  "mpYMDF3cA3tYqDzxq8Vrgm6KkkBz6zLw7bzJnLereuk", // 68
  "HDzxGebwNykPVMEKTqJLHKTbUwJkr8GdvriRpxgFhuxo", // 69
  "8xMyNDbp7HJCGKsjXxSiGWcc1z9h8Ke9hWQMACtgK6CW", // 70
  "HsVLmMLJg8BaE31f7UWnfpZB9huBhdssSaDivnRsXBzp", // 71
  "3Nghb9nyKppet8GLg6daz514vzbyLAynTRJA8qVUi7sM", // 72
  "7iDQAXWMLP3rroyVtu1Xs3QjWEu7uARGUKsE1pKwMUuM", // 73
  "EwUd6XYzUYYsfZrBAEn3JwqA1m1SD56VDRY7sZjUt3JR", // 74
  "4MZfNGichb45kJKznrsVbvTMtNPUxiHpAmki3eZuoyaT", // 75
  "FoPKcN3oSj34wa7rQ8EjxYCg1Lrsu1J5BAtN5KdLwK1F", // 76
  "8UriHR1ANvFFQ53GuNsVmvBoBrNSAn1iix9syVR8rHhb", // 77
  "EoHRcbrUXPtf62FKfjxdaTCfFAmjr7CbooRNQz8cy2LM", // 78
  "6dVh6xZNFwJxCxmJba1aZWsvJCZisbFZWzLNcdiSN531", // 79
  "6qMzxVyM73o7VeLPVvRY3WQfpuTFq9M9W2gD1Wvqw6Jq", // 80
  "Dy8AG1deXLgGVCyMg6xzRznZZyjVE3Zt9gEYabr5Sof8", // 81
  "DNDaPh9QhFAmbUogb6iFbmEDzqjBN7KPFKnPt1eqe4c4", // 82
  "NZ2qqHngfSUUMq6mq2bcUR7UHRiCAFQtSVPoPrFycfH", // 83
  "Edru2jL4RLfUZkfvKYi3QTWmTUonHNbTTDe7TGmWjZdT", // 84
  "2STJxhq84kN9V4f4rXpn6dcs8RTcRePbEHMdfzYFMx9y", // 85
  "8Hu6qSWZsdaXKn35FvAvZcXPr4RHMadscz4mxoHAfp7a", // 86
  "Ep5kyiNSTMz65KHzt4Jem5fZcZXPZGLcCobKATPzrirA", // 87
  "4MyzmwzRye4UcnA9NE7WNhdbqs3L7mKEyxBok8ekZ8Qe", // 88
  "Dc1f667zv8CEZH1LtqwDcqFDB63gDjF7kf4PdpqDx8hp", // 89
  "HuJTocpiVmKdA8WmM4JXBHyoe6Qs7eDBtWKhrZLz3Yug", // 90
  "CCM2ChPPxCpkzaEJpotARr3LeZcG85pVjzzXUnztuHyK", // 91
  "FY4zWAPYh8diJXpzNGeCWNaMFzFMb4sBDofLTSPT3tef", // 92
  "EHXr1S5pEZrshPt5qhMciNch8z1owoKWb455sBkHimzW", // 93
  "91LKpx2KpkFut71WpFBdgbVqWd5E7kVKmW7TejyhUTFk", // 94
  "59ra6vcALKj4bMxDHbetKf7Bz55PET45z3dFGJ5vNkXV", // 95
  "E4tq7SrwrSgafWfFSUZVziqAL42oxHesAqXkpqaYLe9M", // 96
  "Ds5EtBXRs9EUMdxmGrnXNsAmhTD1kPhcG4LQxwsLuttf", // 97
  "B42ZZTYVDLkTNQRHHJJXr36QLcKXk3DLMod7YUeynQnd", // 98
  "9KqMpRrDGptsNkaGfW1TVLSiE7ipf7WRHNXFNWBbqCHA", // 99
];

export const TEST_WALLET_SET: ReadonlySet<string> = new Set(TEST_WALLETS);
